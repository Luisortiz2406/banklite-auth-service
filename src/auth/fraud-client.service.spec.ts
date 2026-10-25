import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FraudClientService } from './fraud-client.service';

const KEY = 'a1'.repeat(32);
const IP = '190.60.37.10';
const report = {
  idUser: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  ip: IP,
};

describe('Reporte de inicios de sesión a fraud-service', () => {
  let fetchMock: jest.SpyInstance;
  let warn: jest.SpyInstance;
  const client = (env: Record<string, string | undefined> = {}) =>
    new FraudClientService(
      new ConfigService({ FRAUD_SERVICE_URL: 'http://fraud:3009/', INTERNAL_API_KEY: KEY, ...env }),
    );

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"stored":true}', { status: 202 }));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('manda la IP del gateway, el resultado y su clave interna a /internal/fraud/logins', async () => {
    expect(await client().send({ ...report, outcome: 'success' })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://fraud:3009/internal/fraud/logins');
    expect(init.headers['x-internal-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toMatchObject({ ...report, outcome: 'success' });
  });

  it('sin FRAUD_SERVICE_URL, sin IP o con una IP inválida no llama a nadie', async () => {
    expect(await client({ FRAUD_SERVICE_URL: '' }).send({ ...report, outcome: 'success' })).toBe(false);
    expect(await client().send({ ...report, ip: undefined, outcome: 'success' })).toBe(false);
    expect(await client().send({ ...report, ip: 'no-es-ip', outcome: 'failed' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si fraud-service no responde o falla, no lanza y el log no tiene la IP', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client().send({ ...report, outcome: 'success' })).resolves.toBe(false);
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(client().send({ ...report, outcome: 'success' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(IP);
  });

  it('reportLogin no espera la respuesta (el inicio de sesión no se frena)', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined)); // nunca responde
    const start = Date.now();
    client().reportLogin({ ...report, outcome: 'success' });
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('POST /auth/login pasa la IP del gateway', () => {
  it('el controlador le entrega x-client-ip al servicio de login', async () => {
    // Import diferido: el controlador arrastra el resto del módulo de auth.
    const { AuthController } = await import('./auth.controller');
    const service = { login: jest.fn().mockResolvedValue({ accessToken: 't' }) };
    const controller = new AuthController(service as never);
    await controller.login({ username: 'ana', password: '12341234' }, '190.60.37.10');
    expect(service.login).toHaveBeenCalledWith({ username: 'ana', password: '12341234' }, '190.60.37.10');
  });
});
