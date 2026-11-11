import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycClientService } from './kyc-client.service';
import { WhatsappOtpClientService } from './whatsapp-otp-client.service';

/** Llamadas de auth a KYC y a notificaciones (fetch simulado): fallan cerrado y no inventan éxitos. */

const KEY = 'clave-interna-de-auth-para-pruebas-012345678';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('Clientes internos de auth', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const config = (env: Record<string, string> = {}) => new ConfigService({ INTERNAL_API_KEY: KEY, ...env });
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('no lanzó excepción');
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('KycClientService', () => {
    it('la identidad solo cuenta como verificada si KYC dice exactamente verified: true', async () => {
      const kyc = new KycClientService(config({ KYC_SERVICE_URL: 'http://kyc.interno:3003' }));

      fetchMock.mockReturnValueOnce(reply(200, { verified: true, nombreCompleto: 'Ana Pérez' }));
      expect(await kyc.getIdentityStatus('u/1')).toEqual({ verified: true, nombreCompleto: 'Ana Pérez' });
      expect(fetchMock.mock.calls[0][0]).toBe('http://kyc.interno:3003/kyc/status/u%2F1');
      expect(fetchMock.mock.calls[0][1].headers['x-internal-key']).toBe(KEY);

      for (const body of [{ verified: 'true' }, { verified: 1 }, { verified: false }, {}]) {
        fetchMock.mockReturnValueOnce(reply(200, body));
        expect(await kyc.getIdentityStatus('u1')).toEqual({ verified: false, nombreCompleto: null });
      }
    });

    it('si KYC no responde o falla, no se confirma la identidad: 503 y no se crea la cuenta', async () => {
      const kyc = new KycClientService(config());
      fetchMock.mockReturnValue(reply(503, { message: 'boom' }));

      const error = await failure(kyc.getIdentityStatus('u1'));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toContain('No se pudo confirmar la verificación de identidad');
      expect(fetchMock).toHaveBeenCalledTimes(2); // la lectura reintenta una vez
    });

    it('sincroniza el contacto verificado con un PATCH y propaga el rechazo', async () => {
      const kyc = new KycClientService(config());
      fetchMock.mockReturnValueOnce(reply(200));
      await kyc.updateVerifiedContact('u1', { telefono: '+573001234567' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3003/kyc/contact');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ idUser: 'u1', telefono: '+573001234567' });

      fetchMock.mockReturnValueOnce(reply(404, { message: 'Usuario no encontrado' }));
      expect((await failure(kyc.updateVerifiedContact('u1', { email: 'a@b.co' }))).getStatus()).toBe(404);
    });

    it('sin INTERNAL_API_KEY no sale ninguna llamada', async () => {
      const kyc = new KycClientService(new ConfigService({}));
      expect(await failure(kyc.getIdentityStatus('u1'))).toBeInstanceOf(ServiceUnavailableException);
      expect(await failure(kyc.updateVerifiedContact('u1', {}))).toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('WhatsappOtpClientService', () => {
    it('cada operación llama a su ruta de notificaciones con el usuario, el celular y el código', async () => {
      const otp = new WhatsappOtpClientService(config({ NOTIFICATION_SERVICE_URL: 'http://notif.interno:3005' }));
      fetchMock.mockReturnValue(reply(200, { sent: true }));

      await otp.sendCode('u1', '+573001234567');
      await otp.verifyCode('u1', '+573001234567', '123456');
      await otp.sendPasswordRecoveryCode('u1', '+573001234567');
      await otp.verifyPasswordRecoveryCode('u1', '+573001234567', '654321');

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        'http://notif.interno:3005/otp/send',
        'http://notif.interno:3005/otp/verify',
        'http://notif.interno:3005/otp/password-reset/send',
        'http://notif.interno:3005/otp/password-reset/verify',
      ]);
      expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
        idUser: 'u1',
        phone: '+573001234567',
        code: '654321',
      });
      expect(fetchMock.mock.calls[0][1].headers['x-internal-key']).toBe(KEY);
    });

    it('un código incorrecto (400 de notificaciones) llega al cliente con su estado; una caída es 503', async () => {
      const otp = new WhatsappOtpClientService(config());
      fetchMock.mockReturnValueOnce(reply(400, { message: 'Código incorrecto.' }));
      const wrong = await failure(otp.verifyCode('u1', '+573001234567', '000000'));
      expect(wrong.getStatus()).toBe(400);
      expect(wrong.message).toBe('Código incorrecto.');

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const down = await failure(otp.sendCode('u1', '+573001234567'));
      expect(down).toBeInstanceOf(ServiceUnavailableException);
      expect(down.message).toContain('servicio de notificaciones');
    });

    it('sin INTERNAL_API_KEY no sale ninguna llamada', async () => {
      const otp = new WhatsappOtpClientService(new ConfigService({}));
      expect(await failure(otp.sendCode('u1', '+573001234567'))).toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
