import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  const service = {
    register: jest.fn().mockResolvedValue({ idUser: 'u1' }),
    checkUsernameAvailability: jest.fn().mockResolvedValue({ available: true }),
    checkEmailAvailability: jest.fn().mockResolvedValue({ available: false }),
    checkPhoneAvailability: jest.fn().mockResolvedValue({ available: false }),
    sendEmailVerification: jest.fn().mockResolvedValue({ sent: true }),
    verifyEmailVerification: jest.fn().mockResolvedValue({ verified: true }),
    sendWhatsappVerification: jest.fn().mockResolvedValue({ sent: true }),
    verifyWhatsappVerification: jest.fn().mockResolvedValue({ verified: true }),
    contactVerificationStatus: jest.fn().mockResolvedValue({ emailVerified: true }),
    login: jest.fn().mockResolvedValue({ accessToken: 't' }),
    requestPasswordReset: jest.fn().mockResolvedValue({ accepted: true }),
    resetPassword: jest.fn().mockResolvedValue({ reset: true }),
    refreshToken: jest.fn().mockResolvedValue({ accessToken: 't2' }),
  };
  const controller = new AuthController(service as unknown as AuthService);

  it('el login pasa la IP que puso el gateway (x-client-ip) y las credenciales tal cual', async () => {
    const dto = { email: 'a@b.co', password: '13571357' } as never;

    expect(await controller.login(dto, '203.0.113.7')).toEqual({ accessToken: 't' });

    expect(service.login).toHaveBeenCalledWith(dto, '203.0.113.7');
  });

  it('disponibilidad: sin el dato a consultar responde disponible sin ir a la base', () => {
    expect(controller.checkEmail({} as never)).toEqual({ available: true });
    expect(controller.checkPhone({} as never)).toEqual({ available: true });
    expect(service.checkEmailAvailability).not.toHaveBeenCalled();

    controller.checkEmail({ email: 'a@b.co' } as never);
    controller.checkPhone({ phone: '+573001234567' } as never);
    controller.checkUsername({ username: 'ana' } as never);
    expect(service.checkEmailAvailability).toHaveBeenCalledWith('a@b.co');
    expect(service.checkPhoneAvailability).toHaveBeenCalledWith('+573001234567');
    expect(service.checkUsernameAvailability).toHaveBeenCalledWith('ana');
  });

  it('registro, verificación de contacto y renovación del token delegan en el servicio', async () => {
    const register = { idUser: 'u1' } as never;
    await controller.register(register);
    expect(service.register).toHaveBeenCalledWith(register);

    await controller.sendEmailCode({ idUser: 'u1', email: 'a@b.co' } as never);
    await controller.verifyEmailCode({ idUser: 'u1', email: 'a@b.co', code: '123456' } as never);
    await controller.sendWhatsappCode({ idUser: 'u1', phone: '+573001234567' } as never);
    await controller.verifyWhatsappCode({ idUser: 'u1', phone: '+573001234567', code: '123456' } as never);
    await controller.verificationStatus({ idUser: 'u1', email: 'a@b.co' } as never);
    expect(service.sendEmailVerification).toHaveBeenCalledWith('u1', 'a@b.co');
    expect(service.verifyEmailVerification).toHaveBeenCalledWith('u1', 'a@b.co', '123456');
    expect(service.sendWhatsappVerification).toHaveBeenCalledWith('u1', '+573001234567');
    expect(service.verifyWhatsappVerification).toHaveBeenCalledWith('u1', '+573001234567', '123456');
    expect(service.contactVerificationStatus).toHaveBeenCalledWith('u1', 'a@b.co');

    await controller.refreshToken({ refreshToken: 'r' } as never);
    expect(service.refreshToken).toHaveBeenCalledWith({ refreshToken: 'r' });
  });

  it('la recuperación de clave manda el dato de la cuenta y el canal, sin mezclar campos', async () => {
    await controller.requestPasswordReset({ username: 'ana', email: 'a@b.co', channel: 'email' } as never);
    expect(service.requestPasswordReset).toHaveBeenCalledWith(
      { username: 'ana', email: 'a@b.co', phone: undefined },
      'email',
    );

    await controller.resetPassword({
      phone: '+573001234567',
      channel: 'whatsapp',
      code: '123456',
      password: '24682468',
    } as never);
    expect(service.resetPassword).toHaveBeenCalledWith(
      { username: undefined, email: undefined, phone: '+573001234567' },
      'whatsapp',
      '123456',
      '24682468',
    );
  });
});
