import { randomUUID } from 'crypto';
import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AdminController } from '../admin/admin.controller';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventOutbox } from '../events/event-outbox.entity';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AuthService } from './auth.service';
import { POLITICA_DESACTUALIZADA, POLITICA_PRIVACIDAD_VIGENTE, TERMINOS_VIGENTES } from './consentimientos';
import { ConsentimientosController } from './consentimientos.controller';
import { ConsentimientosService } from './consentimientos.service';
import { Consentimiento } from './entities/consentimiento.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';

const JWT_SECRET = 'secreto-de-prueba-para-tokens-de-cliente-0123456789';
const STAFF_SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
const IP = '190.60.37.10';

/**
 * Clientes que ya existían: aceptación desde el modal, marca "cons" en el token
 * de acceso y reporte a fraud solo con la autorización vigente. Contra PostgreSQL.
 */
describeWithDb('Consentimiento de clientes existentes (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let usuarios: Repository<UsuarioAuth>;
  let consentimientos: ConsentimientosService;
  let auth: AuthService;
  let controller: ConsentimientosController;
  const jwt = new JwtService({});
  const config = new ConfigService({ JWT_SECRET, STAFF_JWT_SECRET: STAFF_SECRET });
  const fraud = { reportLogin: jest.fn() };
  const events = {
    publish: jest.fn(async (routingKey: string, payload: Record<string, unknown>, manager: EntityManager) => {
      const repo = manager.getRepository(EventOutbox);
      await repo.save(repo.create({ routingKey, payload, occurredAt: new Date() }));
    }),
    flush: jest.fn(),
  };
  let passwordOk = true;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('auth_cons', [
      UsuarioAuth,
      SesionActiva,
      PhoneVerification,
      PasswordResetChallenge,
      Consentimiento,
      EventOutbox,
    ]));
    usuarios = dataSource.getRepository(UsuarioAuth);
    consentimientos = new ConsentimientosService(dataSource.getRepository(Consentimiento));
    auth = new AuthService(
      usuarios,
      dataSource.getRepository(SesionActiva),
      jwt,
      config,
      events as never,
      { verify: async () => ({ valid: passwordOk, needsUpgrade: false }) } as never,
      {} as never,
      {} as never,
      {} as never,
      fraud as never,
      {} as never,
      dataSource.getRepository(PasswordResetChallenge),
      consentimientos,
    );
    controller = new ConsentimientosController(consentimientos, auth, fraud as never, jwt, config);
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
    passwordOk = true;
  });

  /** Cliente que ya existía antes de guardar la aceptación (sin filas en consentimientos). */
  const clienteAnterior = async () => {
    const idUser = randomUUID();
    await usuarios.save(
      usuarios.create({
        idUser,
        email: `cliente-${idUser.slice(0, 8)}@banklite.test`,
        username: `c${idUser.slice(0, 8)}`,
        passwordHash: 'hash',
        passwordHashVersion: 2,
        status: 'active',
      }),
    );
    return idUser;
  };
  const login = (username: string) => auth.login({ username, password: '13571357' }, IP);
  const usernameOf = async (idUser: string) => (await usuarios.findOneByOrFail({ idUser })).username!;
  const payload = (token: string) => jwt.verify(token, { secret: JWT_SECRET });
  const bearer = (token: string) => `Bearer ${token}`;

  describe('estado y aceptación', () => {
    it('un cliente anterior no tiene aceptación vigente (no se rellena nada)', async () => {
      const idUser = await clienteAnterior();
      expect(await consentimientos.estado(idUser)).toMatchObject({
        vigente: false,
        privacidad: null,
        terminos: null,
        versionesVigentes: { privacidad: POLITICA_PRIVACIDAD_VIGENTE, terminos: TERMINOS_VIGENTES },
      });
      expect(await dataSource.getRepository(Consentimiento).count()).toBe(0);
    });

    it('aceptar guarda privacidad y términos vigentes y es idempotente (conserva la fecha)', async () => {
      const idUser = await clienteAnterior();
      const primera = await consentimientos.aceptar(idUser, POLITICA_PRIVACIDAD_VIGENTE);
      expect(primera.nueva).toBe(true);
      expect(primera.estado.vigente).toBe(true);
      const segunda = await consentimientos.aceptar(idUser, POLITICA_PRIVACIDAD_VIGENTE);
      expect(segunda.nueva).toBe(false);
      expect(segunda.estado.privacidad!.aceptadoEn).toEqual(primera.estado.privacidad!.aceptadoEn);
      expect(await dataSource.getRepository(Consentimiento).count()).toBe(2);
    });

    it('una versión que no es la vigente: 400 con el mensaje amable, sin guardar nada', async () => {
      const idUser = await clienteAnterior();
      await expect(consentimientos.aceptar(idUser, '2026-10-01')).rejects.toThrow(POLITICA_DESACTUALIZADA);
      await expect(consentimientos.aceptar(idUser, '2026-10-01')).rejects.toBeInstanceOf(BadRequestException);
      expect(await dataSource.getRepository(Consentimiento).count()).toBe(0);
    });
  });

  describe('inicio de sesión, marca cons y reporte a fraud', () => {
    it('sin aceptación vigente: token sin cons y la IP NO se reporta a fraud', async () => {
      const idUser = await clienteAnterior();
      const { accessToken } = await login(await usernameOf(idUser));
      expect(payload(accessToken).cons).toBeUndefined();
      expect(fraud.reportLogin).not.toHaveBeenCalled();
    });

    it('con aceptación vigente: token con cons y se reporta como siempre', async () => {
      const idUser = await clienteAnterior();
      await consentimientos.aceptar(idUser, POLITICA_PRIVACIDAD_VIGENTE);
      const { accessToken } = await login(await usernameOf(idUser));
      expect(payload(accessToken).cons).toBe(true);
      expect(fraud.reportLogin).toHaveBeenCalledWith(expect.objectContaining({ idUser, ip: IP, outcome: 'success' }));
    });

    it('un inicio de sesión fallido sin aceptación vigente tampoco se reporta', async () => {
      const idUser = await clienteAnterior();
      passwordOk = false;
      await expect(login(await usernameOf(idUser))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(fraud.reportLogin).not.toHaveBeenCalled();
    });

    it('renovar el token recalcula la marca (antes y después de aceptar)', async () => {
      const idUser = await clienteAnterior();
      const { refreshToken } = await login(await usernameOf(idUser));
      expect(payload((await auth.refreshToken({ refreshToken })).accessToken).cons).toBeUndefined();
      await consentimientos.aceptar(idUser, POLITICA_PRIVACIDAD_VIGENTE);
      expect(payload((await auth.refreshToken({ refreshToken })).accessToken).cons).toBe(true);
    });
  });

  describe('POST /auth/consentimientos (modal)', () => {
    it('acepta, devuelve un token con cons y recién ahora reporta la sesión a fraud con la IP', async () => {
      const idUser = await clienteAnterior();
      const { accessToken } = await login(await usernameOf(idUser));
      const result = await controller.aceptar(
        { politicaVersion: POLITICA_PRIVACIDAD_VIGENTE },
        bearer(accessToken),
        IP,
      );
      expect(result.vigente).toBe(true);
      expect(payload(result.accessToken)).toMatchObject({ sub: idUser, type: 'access', cons: true });
      expect(fraud.reportLogin).toHaveBeenCalledTimes(1);
      expect(fraud.reportLogin).toHaveBeenCalledWith({ idUser, ip: IP, outcome: 'success' });

      // Repetir (doble clic) no vuelve a reportar.
      await controller.aceptar({ politicaVersion: POLITICA_PRIVACIDAD_VIGENTE }, bearer(result.accessToken), IP);
      expect(fraud.reportLogin).toHaveBeenCalledTimes(1);
    });

    it('sin token, con un token inválido o con un token de empleado: 401', async () => {
      const dto = { politicaVersion: POLITICA_PRIVACIDAD_VIGENTE };
      await expect(controller.aceptar(dto, undefined, IP)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.aceptar(dto, 'Bearer no-es-un-jwt', IP)).rejects.toBeInstanceOf(UnauthorizedException);
      const staff = jwt.sign({ sub: 'staff-1', type: 'staff', role: 'admin' }, { secret: JWT_SECRET });
      await expect(controller.estado(bearer(staff))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await dataSource.getRepository(Consentimiento).count()).toBe(0);
    });
  });

  describe('panel: GET /auth/admin/customers/:idUser/consentimientos', () => {
    const guard = new StaffAuthGuard(jwt, config, new Reflector());
    const context = (role: string): ExecutionContext => {
      const token = jwt.sign({ sub: `staff-${role}`, type: 'staff', role, username: role }, { secret: STAFF_SECRET });
      const request = { headers: { authorization: `Bearer ${token}` } };
      return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => AdminController.prototype.customerConsents,
        getClass: () => AdminController,
      } as unknown as ExecutionContext;
    };

    it('soporte: 403; cumplimiento y administrador: pasan', () => {
      expect(() => guard.canActivate(context('support'))).toThrow(ForbiddenException);
      expect(guard.canActivate(context('compliance'))).toBe(true);
      expect(guard.canActivate(context('admin'))).toBe(true);
    });

    it('devuelve la aceptación (o su ausencia) y registra la consulta en la auditoría', async () => {
      const audit = { record: jest.fn() };
      const admin = new AdminController({} as never, {} as never, audit as never, {} as never, consentimientos);
      const anterior = await clienteAnterior();
      const sinAceptacion = await admin.customerConsents(anterior, {
        staff: { username: 'laura', role: 'compliance' },
      });
      expect(sinAceptacion).toMatchObject({ vigente: false, historial: [] });

      await consentimientos.aceptar(anterior, POLITICA_PRIVACIDAD_VIGENTE);
      const conAceptacion = await admin.customerConsents(anterior, {
        staff: { username: 'laura', role: 'compliance' },
      });
      expect(conAceptacion.vigente).toBe(true);
      expect(conAceptacion.historial.map((h) => h.documento).sort()).toEqual(['privacidad', 'terminos']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'laura' }),
        expect.objectContaining({ action: 'customer.consents.view', targetId: anterior }),
      );
    });
  });
});
