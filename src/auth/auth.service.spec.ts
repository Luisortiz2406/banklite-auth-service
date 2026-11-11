import { createHash, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, Repository } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AuthService } from './auth.service';
import { documentosAceptados, POLITICA_PRIVACIDAD_VIGENTE } from './consentimientos';
import { Consentimiento } from './entities/consentimiento.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';

/**
 * Inicio de sesión, renovación del token, registro y recuperación de clave contra
 * PostgreSQL real. Lo más importante: 5 claves incorrectas bloquean, una cuenta
 * cancelada o suspendida no entra, un refresh revocado no sirve y la recuperación
 * se bloquea tras 3 intentos fallidos.
 */

const JWT_SECRET = 'secreto-de-los-tokens-de-cliente-0123456789ab';
const PASSWORD = '13571357';
const PHONE = '+573001234567';

describeWithDb('AuthService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let usuarios: Repository<UsuarioAuth>;
  let sesiones: Repository<SesionActiva>;
  let phones: Repository<PhoneVerification>;
  let challenges: Repository<PasswordResetChallenge>;
  let auth: AuthService;
  let jwt: JwtService;
  let consentimientoVigente: boolean;

  // Dependencias externas simuladas.
  const events = { publish: jest.fn(), flush: jest.fn() };
  const emailService = {
    sendCode: jest.fn(),
    verifyCode: jest.fn(),
    isVerified: jest.fn(),
    sendPasswordResetCode: jest.fn(),
    sendRecoveryBlockedAlert: jest.fn(),
  };
  const kyc = {
    getIdentityStatus: jest.fn(),
    updateVerifiedContact: jest.fn(),
  };
  const whatsapp = {
    sendCode: jest.fn(),
    verifyCode: jest.fn(),
    sendPasswordRecoveryCode: jest.fn(),
    verifyPasswordRecoveryCode: jest.fn(),
  };
  const fraud = { reportLogin: jest.fn() };
  const consentimientos = { tieneVigente: jest.fn(async () => consentimientoVigente) };
  // Hasher rápido con la misma interfaz que PasswordHasher (el real se prueba aparte).
  const hasher = {
    hash: jest.fn(async (password: string) => ({ hash: `hash:${password}`, version: 2 })),
    verify: jest.fn(async (password: string, hash: string | null, version: number) => {
      const valid = hash === `hash:${password}`;
      return { valid, needsUpgrade: valid && version === 1 };
    }),
  };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('auth_service', [
      UsuarioAuth,
      SesionActiva,
      PhoneVerification,
      PasswordResetChallenge,
      Consentimiento,
    ]));
    usuarios = dataSource.getRepository(UsuarioAuth);
    sesiones = dataSource.getRepository(SesionActiva);
    phones = dataSource.getRepository(PhoneVerification);
    challenges = dataSource.getRepository(PasswordResetChallenge);
    jwt = new JwtService({});
    auth = new AuthService(
      usuarios,
      sesiones,
      jwt,
      new ConfigService({ JWT_SECRET }),
      events as never,
      hasher as never,
      emailService as never,
      kyc as never,
      whatsapp as never,
      fraud as never,
      phones,
      challenges,
      consentimientos as never,
    );
  });
  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
    consentimientoVigente = false;
    emailService.isVerified.mockResolvedValue(true);
    emailService.sendPasswordResetCode.mockResolvedValue(undefined);
    emailService.sendRecoveryBlockedAlert.mockResolvedValue(undefined);
    kyc.getIdentityStatus.mockResolvedValue({ verified: true, nombreCompleto: 'Ana Pérez' });
    whatsapp.sendPasswordRecoveryCode.mockResolvedValue({ sent: true });
    whatsapp.verifyPasswordRecoveryCode.mockResolvedValue({ verified: true });
  });

  const crearCliente = async (overrides: Partial<UsuarioAuth> = {}) => {
    const idUser = randomUUID();
    const usuario = await usuarios.save(
      usuarios.create({
        idUser,
        email: `cliente-${idUser.slice(0, 8)}@banklite.test`,
        username: `cliente${idUser.slice(0, 8)}`,
        passwordHash: `hash:${PASSWORD}`,
        passwordHashVersion: 2,
        status: 'active',
        ...overrides,
      }),
    );
    return usuario;
  };
  const login = (usuario: UsuarioAuth, password = PASSWORD, ip?: string) =>
    auth.login({ email: usuario.email, password }, ip);
  const fresh = (idUser: string) => usuarios.findOneByOrFail({ idUser });
  const publishedEvents = () => events.publish.mock.calls.map((call) => call[0]);

  describe('iniciar sesión', () => {
    it('con el correo (sin importar mayúsculas) o con el usuario devuelve los tokens y guarda la sesión', async () => {
      const usuario = await crearCliente();

      const byEmail = await auth.login({ email: usuario.email.toUpperCase(), password: PASSWORD });
      const byUsername = await auth.login({ username: ` ${usuario.username!.toUpperCase()} `, password: PASSWORD });

      for (const result of [byEmail, byUsername]) {
        expect(jwt.verify(result.accessToken, { secret: JWT_SECRET })).toMatchObject({
          sub: usuario.idUser,
          type: 'access',
        });
        expect(jwt.verify(result.refreshToken, { secret: JWT_SECRET })).toMatchObject({
          sub: usuario.idUser,
          type: 'refresh',
        });
      }
      const sessions = await sesiones.find({ where: { idUser: usuario.idUser } });
      expect(sessions).toHaveLength(2);
      // El refresh token se guarda como SHA-256, nunca en claro.
      expect(sessions.map((s) => s.refreshTokenHash)).toContain(
        createHash('sha256').update(byEmail.refreshToken).digest('hex'),
      );
      expect(sessions.every((s) => s.activa && s.mfaVerified)).toBe(true);
      expect(publishedEvents()).toEqual(['usuario_autenticado', 'usuario_autenticado']);
    });

    it('sin la autorización de datos vigente el token sale sin "cons" y no se reporta la IP a fraud', async () => {
      const usuario = await crearCliente();
      const sinConsentimiento = await login(usuario, PASSWORD, '203.0.113.7');
      expect(jwt.decode(sinConsentimiento.accessToken)).not.toHaveProperty('cons');
      expect(fraud.reportLogin).not.toHaveBeenCalled();

      consentimientoVigente = true;
      const conConsentimiento = await login(usuario, PASSWORD, '203.0.113.7');
      expect(jwt.decode(conConsentimiento.accessToken)).toMatchObject({ cons: true });
      expect(fraud.reportLogin).toHaveBeenCalledWith(
        expect.objectContaining({ idUser: usuario.idUser, ip: '203.0.113.7', outcome: 'success' }),
      );
    });

    it('exige usuario o correo; un usuario que no existe es 401 y se gasta el mismo tiempo de verificación', async () => {
      await expect(auth.login({ password: PASSWORD })).rejects.toBeInstanceOf(BadRequestException);
      await expect(auth.login({ email: 'nadie@banklite.test', password: PASSWORD })).rejects.toThrow(
        'Credenciales inválidas',
      );
      await expect(auth.login({ username: 'nadie', password: PASSWORD })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(hasher.verify).toHaveBeenCalledWith(PASSWORD, null, 1);
    });

    it('una clave incorrecta cuenta el intento, avisa con un evento y responde igual que un usuario inexistente', async () => {
      const usuario = await crearCliente();
      consentimientoVigente = true;

      await expect(login(usuario, '99999999', '203.0.113.7')).rejects.toThrow('Credenciales inválidas');

      expect((await fresh(usuario.idUser)).failedLoginAttempts).toBe(1);
      expect(publishedEvents()).toEqual(['intento_fallido_login']);
      expect(fraud.reportLogin).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
      expect(await sesiones.count()).toBe(0);
    });

    it('el quinto intento fallido bloquea 30 minutos, y bloqueada no entra ni con la clave correcta', async () => {
      const usuario = await crearCliente();
      for (let i = 0; i < 5; i++) await login(usuario, '99999999').catch(() => undefined);

      const blocked = await fresh(usuario.idUser);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

      await expect(login(usuario)).rejects.toThrow('bloqueada temporalmente');
      expect(await sesiones.count()).toBe(0);
    });

    it('vencido el bloqueo, la clave correcta entra y deja los contadores en cero', async () => {
      const usuario = await crearCliente({
        status: 'blocked',
        failedLoginAttempts: 5,
        blockedUntil: new Date(Date.now() - 1_000),
        recoveryBlocked: true,
        recoveryFailedAttempts: 3,
      });

      await expect(login(usuario)).resolves.toHaveProperty('accessToken');

      expect(await fresh(usuario.idUser)).toMatchObject({
        status: 'active',
        failedLoginAttempts: 0,
        blockedUntil: null,
        recoveryBlocked: false,
        recoveryFailedAttempts: 0,
      });
    });

    it('una cuenta cancelada o suspendida por el banco no entra, y solo se les dice con la clave correcta', async () => {
      const cancelada = await crearCliente({ closedAt: new Date('2026-10-01T12:00:00Z') });
      await expect(login(cancelada)).rejects.toThrow('Tu cuenta fue cancelada el');
      await expect(login(cancelada)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(login(cancelada, '99999999')).rejects.toBeInstanceOf(UnauthorizedException);

      const suspendida = await crearCliente({ disabledByBank: true });
      await expect(login(suspendida)).rejects.toThrow('acceso fue suspendido por el banco');
      await expect(login(suspendida, '99999999')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await sesiones.count()).toBe(0);
    });

    it('una clave guardada con el esquema anterior entra y se vuelve a guardar con el actual', async () => {
      const usuario = await crearCliente({ passwordHashVersion: 1 });

      await login(usuario);

      expect(await fresh(usuario.idUser)).toMatchObject({ passwordHash: `hash:${PASSWORD}`, passwordHashVersion: 2 });
      expect(hasher.hash).toHaveBeenCalledWith(PASSWORD);
    });
  });

  describe('renovar el token (refresh)', () => {
    it('con un refresh vigente entrega un access token nuevo', async () => {
      const usuario = await crearCliente();
      const { refreshToken } = await login(usuario);

      const { accessToken } = await auth.refreshToken({ refreshToken });

      expect(jwt.verify(accessToken, { secret: JWT_SECRET })).toMatchObject({ sub: usuario.idUser, type: 'access' });
    });

    it('si la política cambió, el access token nuevo vuelve a salir sin "cons"', async () => {
      const usuario = await crearCliente();
      consentimientoVigente = true;
      const { refreshToken } = await login(usuario);
      expect(jwt.decode((await auth.refreshToken({ refreshToken })).accessToken)).toMatchObject({ cons: true });

      consentimientoVigente = false;
      expect(jwt.decode((await auth.refreshToken({ refreshToken })).accessToken)).not.toHaveProperty('cons');
    });

    it('rechaza un token roto, uno de otro secreto y un access token usado como refresh', async () => {
      const usuario = await crearCliente();
      const { accessToken } = await login(usuario);
      const foreign = jwt.sign(
        { sub: usuario.idUser, type: 'refresh' },
        { secret: 'otro-secreto-distinto-de-32-caracteres!!' },
      );

      await expect(auth.refreshToken({ refreshToken: 'no.es.jwt' })).rejects.toThrow('inválido o expirado');
      await expect(auth.refreshToken({ refreshToken: foreign })).rejects.toThrow('inválido o expirado');
      await expect(auth.refreshToken({ refreshToken: accessToken })).rejects.toThrow('no es de tipo refresh');
    });

    it('una sesión revocada, vencida o desconocida no renueva', async () => {
      const usuario = await crearCliente();
      const { refreshToken } = await login(usuario);
      const desconocido = jwt.sign({ sub: usuario.idUser, type: 'refresh', jti: randomUUID() }, { secret: JWT_SECRET });
      await expect(auth.refreshToken({ refreshToken: desconocido })).rejects.toThrow('Sesión revocada');

      await sesiones.update({ idUser: usuario.idUser }, { expiresAt: new Date(Date.now() - 1_000) });
      await expect(auth.refreshToken({ refreshToken })).rejects.toThrow('Sesión revocada');

      await sesiones.update(
        { idUser: usuario.idUser },
        { expiresAt: new Date(Date.now() + 86_400_000), activa: false },
      );
      await expect(auth.refreshToken({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('si la cuenta se suspendió o se canceló después del login, ya no renueva', async () => {
      const usuario = await crearCliente();
      const { refreshToken } = await login(usuario);

      await usuarios.update({ idUser: usuario.idUser }, { disabledByBank: true });
      await expect(auth.refreshToken({ refreshToken })).rejects.toThrow('acceso de esta cuenta está suspendido');

      await usuarios.update({ idUser: usuario.idUser }, { disabledByBank: false, closedAt: new Date() });
      await expect(auth.refreshToken({ refreshToken })).rejects.toThrow('acceso de esta cuenta está suspendido');

      await usuarios.delete({ idUser: usuario.idUser });
      await expect(auth.refreshToken({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('registro', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      idUser: randomUUID(),
      email: ' Nueva.Cliente@Banklite.Test ',
      username: ' NuevaCliente ',
      password: PASSWORD,
      politicaVersion: POLITICA_PRIVACIDAD_VIGENTE,
      ...overrides,
    });
    const withPhone = async (idUser: string) => {
      await phones.save({ idUser, phone: `+57300${Math.floor(1000000 + Math.random() * 8999999)}`, verified: true });
      return idUser;
    };

    it('crea las credenciales, acepta las políticas vigentes y publica account.created en la misma transacción', async () => {
      const request = dto();
      await withPhone(request.idUser);

      const result = await auth.register(request as never);

      expect(result).toEqual({ idUser: request.idUser, email: 'nueva.cliente@banklite.test' });
      expect(await fresh(request.idUser)).toMatchObject({
        email: 'nueva.cliente@banklite.test',
        username: 'nuevacliente',
        passwordHash: `hash:${PASSWORD}`,
        passwordHashVersion: 2,
        status: 'active',
      });
      const accepted = await dataSource.getRepository(Consentimiento).find({ where: { idUser: request.idUser } });
      expect(accepted.map((c) => c.documento).sort()).toEqual(
        documentosAceptados()
          .map((d) => d.documento)
          .sort(),
      );
      expect(events.publish).toHaveBeenCalledWith(
        'account.created',
        expect.objectContaining({ idUser: request.idUser, nombreCompleto: 'Ana Pérez' }),
        expect.anything(),
      );
      expect(events.flush).toHaveBeenCalled();
    });

    it('rechaza una política desactualizada y claves inseguras (repetidas, seguidas o comunes)', async () => {
      await expect(auth.register(dto({ politicaVersion: '2020-01-01' }) as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      for (const password of ['11111111', '12341234', '43214321', '25802580', '08520852']) {
        await expect(auth.register(dto({ password }) as never)).rejects.toThrow('Esta clave es insegura');
      }
      await expect(auth.register(dto({ password: '13571357' }) as never)).rejects.not.toThrow('insegura');
      expect(await usuarios.count()).toBe(0);
    });

    it('exige correo, teléfono e identidad verificados antes de crear nada', async () => {
      const request = dto();
      emailService.isVerified.mockResolvedValueOnce(false);
      await expect(auth.register(request as never)).rejects.toThrow('verificar tu correo');

      await expect(auth.register(request as never)).rejects.toThrow('verificar tu teléfono');

      await withPhone(request.idUser);
      kyc.getIdentityStatus.mockResolvedValueOnce({ verified: false });
      await expect(auth.register(request as never)).rejects.toThrow('verificar tu identidad');
      expect(await usuarios.count()).toBe(0);
    });

    it('no repite correo ni usuario, ni deja pasar una carrera por clave única', async () => {
      const existente = await crearCliente({ email: 'nueva.cliente@banklite.test', username: 'ocupado' });
      const request = dto();
      await withPhone(request.idUser);

      await expect(auth.register(request as never)).rejects.toThrow('Ya existe una cuenta con esos datos');

      const otro = dto({ email: 'otra@banklite.test', username: 'OCUPADO' });
      await withPhone(otro.idUser);
      await expect(auth.register(otro as never)).rejects.toThrow('Ese usuario ya está en uso');

      const carrera = dto({ email: 'carrera@banklite.test', username: undefined });
      await withPhone(carrera.idUser);
      jest
        .spyOn(usuarios.manager, 'transaction')
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      await expect(auth.register(carrera as never)).rejects.toThrow('Ya existe una cuenta con esos datos');
      expect(await usuarios.count()).toBe(1);
      expect(existente.idUser).toBeDefined();
    });
  });

  describe('disponibilidad y verificación de contacto', () => {
    it('correo, usuario y teléfono ocupados se reportan; los libres están disponibles', async () => {
      const usuario = await crearCliente();
      await phones.save({ idUser: usuario.idUser, phone: PHONE, verified: true });

      expect(await auth.checkEmailAvailability(usuario.email.toUpperCase())).toMatchObject({ available: false });
      expect(await auth.checkEmailAvailability('libre@banklite.test')).toEqual({ available: true });
      expect(await auth.checkUsernameAvailability(` ${usuario.username!.toUpperCase()} `)).toEqual({
        available: false,
      });
      expect(await auth.checkUsernameAvailability('libre')).toEqual({ available: true });
      expect(await auth.checkPhoneAvailability(` ${PHONE} `)).toMatchObject({ available: false });
      expect(await auth.checkPhoneAvailability('+573009999999')).toEqual({ available: true });
    });

    it('el estado de verificación dice si el correo y el celular están verificados', async () => {
      const usuario = await crearCliente();
      emailService.isVerified.mockResolvedValue(true);
      expect(await auth.contactVerificationStatus(usuario.idUser, usuario.email)).toEqual({
        emailVerified: true,
        phoneVerified: false,
      });

      await phones.save({ idUser: usuario.idUser, phone: PHONE, verified: true });
      expect((await auth.contactVerificationStatus(usuario.idUser, usuario.email)).phoneVerified).toBe(true);
    });

    it('verificar el celular lo guarda, avisa a KYC y no permite uno que ya es de otra cuenta', async () => {
      const ana = await crearCliente();
      const carlos = await crearCliente();
      whatsapp.verifyCode.mockResolvedValue({ verified: true });

      expect(await auth.verifyWhatsappVerification(ana.idUser, ` ${PHONE} `, '123456')).toEqual({
        verified: true,
        phone: PHONE,
      });
      expect(kyc.updateVerifiedContact).toHaveBeenCalledWith(ana.idUser, { telefono: PHONE });
      expect(await phones.findOneByOrFail({ idUser: ana.idUser })).toMatchObject({ phone: PHONE, verified: true });

      await expect(auth.verifyWhatsappVerification(carlos.idUser, PHONE, '123456')).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Si Ana cambia de número, se actualiza su misma fila.
      await auth.verifyWhatsappVerification(ana.idUser, '+573117654321', '123456');
      expect(await phones.countBy({ idUser: ana.idUser })).toBe(1);
    });

    it('verificar el correo avisa a KYC con el correo en minúsculas', async () => {
      const usuario = await crearCliente();
      emailService.verifyCode.mockResolvedValue({ verified: true });

      await auth.verifyEmailVerification(usuario.idUser, ' Ana@Banklite.Test ', '123456');

      expect(kyc.updateVerifiedContact).toHaveBeenCalledWith(usuario.idUser, { email: 'ana@banklite.test' });
    });
  });

  describe('recuperar la clave', () => {
    const sentCode = () => emailService.sendPasswordResetCode.mock.calls.at(-1)?.[1] as string;
    const solicitar = (usuario: UsuarioAuth) => auth.requestPasswordReset({ email: usuario.email }, 'email');
    const restablecer = (usuario: UsuarioAuth, code: string, password = '24682468') =>
      auth.resetPassword({ email: usuario.email }, 'email', code, password);

    it('por correo: manda un código de 6 dígitos y con él se cambia la clave y se cierran las sesiones', async () => {
      const usuario = await crearCliente();
      await login(usuario);

      expect(await solicitar(usuario)).toEqual({ accepted: true, expiresInSeconds: 300 });
      expect(sentCode()).toMatch(/^\d{6}$/);

      expect(await restablecer(usuario, sentCode())).toEqual({ reset: true });

      expect(await fresh(usuario.idUser)).toMatchObject({ passwordHash: 'hash:24682468', failedLoginAttempts: 0 });
      expect(await sesiones.count({ where: { idUser: usuario.idUser, activa: true } })).toBe(0);
      expect(await challenges.count()).toBe(0);
      await expect(login(usuario, '24682468')).resolves.toHaveProperty('accessToken');
    });

    it('un correo desconocido recibe la misma respuesta y no se envía nada', async () => {
      expect(await auth.requestPasswordReset({ email: 'nadie@banklite.test' }, 'email')).toEqual({
        accepted: true,
        expiresInSeconds: 300,
      });
      expect(emailService.sendPasswordResetCode).not.toHaveBeenCalled();
      await expect(auth.resetPassword({ email: 'nadie@banklite.test' }, 'email', '123456', '24682468')).rejects.toThrow(
        'Código inválido o vencido',
      );
    });

    it('pedir otro código antes de 60 s no manda otro correo', async () => {
      const usuario = await crearCliente();
      await solicitar(usuario);
      await solicitar(usuario);
      expect(emailService.sendPasswordResetCode).toHaveBeenCalledTimes(1);

      await challenges.update({ idUser: usuario.idUser }, { lastSentAt: new Date(Date.now() - 61_000) });
      await solicitar(usuario);
      expect(emailService.sendPasswordResetCode).toHaveBeenCalledTimes(2);
      expect(await challenges.count()).toBe(1);
    });

    it('exige el correo, rechaza una clave insegura, un código vencido y los intentos agotados', async () => {
      const usuario = await crearCliente();
      await expect(auth.requestPasswordReset({}, 'email')).rejects.toThrow('Escribe tu correo registrado');
      await expect(auth.requestPasswordReset({}, 'whatsapp')).rejects.toThrow('número de celular registrado');
      await solicitar(usuario);
      const code = sentCode();

      await expect(restablecer(usuario, code, '11111111')).rejects.toThrow('Esta clave es insegura');

      await challenges.update({ idUser: usuario.idUser }, { expiresAt: new Date(Date.now() - 1_000) });
      await expect(restablecer(usuario, code)).rejects.toThrow('El código venció');

      await challenges.update({ idUser: usuario.idUser }, { expiresAt: new Date(Date.now() + 60_000), attempts: 5 });
      await expect(restablecer(usuario, code)).rejects.toThrow('Superaste los intentos permitidos');
      expect((await fresh(usuario.idUser)).passwordHash).toBe(`hash:${PASSWORD}`);
    });

    it('tres códigos incorrectos bloquean la recuperación, avisan por correo y ni el código bueno sirve después', async () => {
      const usuario = await crearCliente();
      await solicitar(usuario);
      const code = sentCode();
      const wrong = code === '000000' ? '111111' : '000000';

      await expect(restablecer(usuario, wrong)).rejects.toThrow('Código incorrecto');
      await expect(restablecer(usuario, wrong)).rejects.toThrow('Código incorrecto');
      await expect(restablecer(usuario, wrong)).rejects.toBeInstanceOf(ForbiddenException);

      expect((await fresh(usuario.idUser)).recoveryBlocked).toBe(true);
      expect(await challenges.count()).toBe(0);
      await expect(restablecer(usuario, code)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(solicitar(usuario)).rejects.toBeInstanceOf(ForbiddenException);
      await new Promise((resolve) => setImmediate(resolve));
      expect(emailService.sendRecoveryBlockedAlert).toHaveBeenCalledWith(usuario.email, 'Ana Pérez', 3);

      // Iniciar sesión con la clave actual lo desbloquea.
      await login(usuario);
      expect((await fresh(usuario.idUser)).recoveryBlocked).toBe(false);
    });

    it('con usuario, el correo debe ser el de esa cuenta; si no, cuenta como intento fallido', async () => {
      const usuario = await crearCliente();

      await expect(
        auth.requestPasswordReset({ username: usuario.username!, email: 'otro@banklite.test' }, 'email'),
      ).rejects.toThrow('Este correo no pertenece a tu cuenta');
      expect((await fresh(usuario.idUser)).recoveryFailedAttempts).toBe(1);

      await expect(
        auth.requestPasswordReset({ username: 'no-existe', email: 'otro@banklite.test' }, 'email'),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        auth.requestPasswordReset({ username: usuario.username!, email: usuario.email.toUpperCase() }, 'email'),
      ).resolves.toMatchObject({ accepted: true });
    });

    it('por WhatsApp: usa el celular verificado, y el código se valida con el servicio de WhatsApp', async () => {
      const usuario = await crearCliente();
      await phones.save({ idUser: usuario.idUser, phone: PHONE, verified: true });

      await auth.requestPasswordReset({ phone: PHONE }, 'whatsapp');
      expect(whatsapp.sendPasswordRecoveryCode).toHaveBeenCalledWith(usuario.idUser, PHONE);

      whatsapp.verifyPasswordRecoveryCode.mockRejectedValueOnce(new BadRequestException('Código incorrecto.'));
      await expect(auth.resetPassword({ phone: PHONE }, 'whatsapp', '000000', '24682468')).rejects.toThrow(
        'Código incorrecto o vencido',
      );

      expect(await auth.resetPassword({ phone: PHONE }, 'whatsapp', '654321', '24682468')).toEqual({ reset: true });
      expect(whatsapp.verifyPasswordRecoveryCode).toHaveBeenLastCalledWith(usuario.idUser, PHONE, '654321');
      expect((await fresh(usuario.idUser)).passwordHash).toBe('hash:24682468');
    });

    it('por WhatsApp con un celular no verificado no se envía nada, y un canal distinto al pedido no sirve', async () => {
      const usuario = await crearCliente();
      expect(await auth.requestPasswordReset({ phone: '+573119999999' }, 'whatsapp')).toMatchObject({ accepted: true });
      expect(whatsapp.sendPasswordRecoveryCode).not.toHaveBeenCalled();

      await solicitar(usuario);
      await expect(auth.resetPassword({ email: usuario.email }, 'whatsapp', '123456', '24682468')).rejects.toThrow(
        'Código inválido o vencido',
      );
    });
  });
});
