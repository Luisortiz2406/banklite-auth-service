import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, Repository } from 'typeorm';
import { EventOutbox } from '../events/event-outbox.entity';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AuthService } from './auth.service';
import { verifyClosureTicket } from './cierre-ticket';
import { InternalCierreController } from './cierre.controller';
import { CierreService } from './cierre.service';
import { ConsentimientosService } from './consentimientos.service';
import { CierreChallenge } from './entities/cierre-challenge.entity';
import { Consentimiento } from './entities/consentimiento.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';

const CLOSURE_SECRET = 'secreto-del-ticket-de-cierre-0123456789abcdef';
const JWT_SECRET = 'secreto-de-los-tokens-de-cliente-0123456789ab';
const CLAVE = '13571357';
const CODIGO = '482913';

/** Cancelar la cuenta en auth: clave → código por WhatsApp → ticket; y bloqueo del acceso. Contra PostgreSQL. */
describeWithDb('Cierre de cuenta en auth (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let usuarios: Repository<UsuarioAuth>;
  let sesiones: Repository<SesionActiva>;
  let challenges: Repository<CierreChallenge>;
  let cierre: CierreService;
  let auth: AuthService;
  const whatsapp = {
    sendCode: jest.fn(async () => ({ sent: true, expiresInSeconds: 300 })),
    verifyCode: jest.fn(async (_id: string, _phone: string, code: string) => {
      if (code !== CODIGO) throw new BadRequestException('Código incorrecto.');
      return { verified: true };
    }),
  };
  const hasher = { verify: async (password: string) => ({ valid: password === CLAVE, needsUpgrade: false }) };
  const config = (extra: Record<string, string> = {}) =>
    new ConfigService({ JWT_SECRET, CLOSURE_TICKET_SECRET: CLOSURE_SECRET, ...extra });

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('auth_cierre', [
      UsuarioAuth,
      SesionActiva,
      PhoneVerification,
      PasswordResetChallenge,
      CierreChallenge,
      Consentimiento,
      EventOutbox,
    ]));
    usuarios = dataSource.getRepository(UsuarioAuth);
    sesiones = dataSource.getRepository(SesionActiva);
    challenges = dataSource.getRepository(CierreChallenge);
    cierre = newCierre(config());
    auth = new AuthService(
      usuarios,
      sesiones,
      new JwtService({}),
      config(),
      { publish: jest.fn(), flush: jest.fn() } as never,
      hasher as never,
      {} as never,
      {} as never,
      {} as never,
      { reportLogin: jest.fn() } as never,
      {} as never,
      dataSource.getRepository(PasswordResetChallenge),
      new ConsentimientosService(dataSource.getRepository(Consentimiento)),
    );
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.clearAllMocks();
  });

  const newCierre = (cfg: ConfigService) =>
    new CierreService(
      usuarios,
      sesiones,
      dataSource.getRepository(PhoneVerification),
      dataSource.getRepository(PasswordResetChallenge),
      challenges,
      hasher as never,
      whatsapp as never,
      cfg,
    );

  const cliente = async (phone = true) => {
    const idUser = randomUUID();
    await usuarios.save(
      usuarios.create({
        idUser,
        email: `c-${idUser.slice(0, 8)}@banklite.test`,
        username: `c${idUser.slice(0, 8)}`,
        passwordHash: 'hash',
        passwordHashVersion: 2,
        status: 'active',
      }),
    );
    if (phone) {
      await dataSource.getRepository(PhoneVerification).save({ idUser, phone: '+573001234567', verified: true });
    }
    await sesiones.save([
      {
        idUser,
        refreshTokenHash: randomUUID(),
        mfaVerified: true,
        activa: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        idUser,
        refreshTokenHash: randomUUID(),
        mfaVerified: true,
        activa: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    return idUser;
  };

  describe('clave → código → ticket', () => {
    it('con la clave correcta envía el código al celular verificado (enmascarado)', async () => {
      const idUser = await cliente();
      expect(await cierre.iniciar(idUser, CLAVE)).toEqual({
        codigoEnviado: true,
        celular: '•••••••••4567',
        expiraEnSegundos: 300,
      });
      expect(whatsapp.sendCode).toHaveBeenCalledWith(idUser, '+573001234567');
    });

    it('clave incorrecta: 401, no envía código; 5 seguidas bloquean 15 minutos (429)', async () => {
      const idUser = await cliente();
      for (let i = 0; i < 5; i++) {
        await expect(cierre.iniciar(idUser, 'otraclave')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(whatsapp.sendCode).not.toHaveBeenCalled();
      const blocked = await cierre.iniciar(idUser, CLAVE).catch((e) => e);
      expect(blocked).toBeInstanceOf(HttpException);
      expect((blocked as HttpException).getStatus()).toBe(429);
    });

    it('confirmar sin haber dado la clave: 400', async () => {
      const idUser = await cliente();
      await expect(cierre.confirmar(idUser, CODIGO)).rejects.toThrow('Vuelve a escribir tu clave');
    });

    it('código correcto: ticket de un solo pedido, firmado con su propio secreto', async () => {
      const idUser = await cliente();
      await cierre.iniciar(idUser, CLAVE);
      const { ticket, expiraEnSegundos } = await cierre.confirmar(idUser, CODIGO);
      expect(expiraEnSegundos).toBe(300);
      expect(verifyClosureTicket(ticket, CLOSURE_SECRET)).toMatchObject({ sub: idUser, type: 'closure_ticket' });
      expect(verifyClosureTicket(ticket, JWT_SECRET)).toBeNull();
      // Pedir otro ticket exige volver a dar la clave y un código nuevo.
      await expect(cierre.confirmar(idUser, CODIGO)).rejects.toThrow('Vuelve a escribir tu clave');
    });

    it('código incorrecto: cuenta los intentos y al quinto bloquea', async () => {
      const idUser = await cliente();
      await cierre.iniciar(idUser, CLAVE);
      for (let i = 0; i < 4; i++) {
        await expect(cierre.confirmar(idUser, '000000')).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(cierre.confirmar(idUser, '000000')).rejects.toBeInstanceOf(BadRequestException);
      const blocked = await cierre.confirmar(idUser, CODIGO).catch((e) => e);
      expect((blocked as HttpException).getStatus()).toBe(429);
    });

    it('sin celular verificado: 400', async () => {
      const idUser = await cliente(false);
      await expect(cierre.iniciar(idUser, CLAVE)).rejects.toThrow('celular verificado');
    });

    it('sin CLOSURE_TICKET_SECRET: 503 y no se pide la clave ni se envía código', async () => {
      const idUser = await cliente();
      await expect(newCierre(config({ CLOSURE_TICKET_SECRET: '' })).iniciar(idUser, CLAVE)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(whatsapp.sendCode).not.toHaveBeenCalled();
    });
  });

  describe('cerrar el acceso (lo llama account-service)', () => {
    it('marca la fecha, revoca TODAS las sesiones y es idempotente', async () => {
      const idUser = await cliente();
      const fecha = new Date('2026-10-26T15:00:00Z');
      expect(await cierre.cerrarAcceso(idUser, fecha)).toEqual({ cerrado: true, cerradaEn: fecha });
      expect(await sesiones.count({ where: { idUser, activa: true } })).toBe(0);
      expect((await cierre.cerrarAcceso(idUser, new Date())).cerradaEn).toEqual(fecha); // conserva la primera fecha
      expect(await usuarios.count()).toBe(1); // no se borra nada
    });

    it('después de cerrar: el login dice que la cuenta fue cancelada y ya no se puede iniciar el cierre', async () => {
      const idUser = await cliente();
      await cierre.cerrarAcceso(idUser, new Date('2026-10-26T15:00:00Z'));
      const username = (await usuarios.findOneByOrFail({ idUser })).username!;
      await expect(auth.login({ username, password: CLAVE }, '190.60.37.10')).rejects.toThrow(
        'Tu cuenta fue cancelada el 26 de octubre de 2026',
      );
      await expect(cierre.iniciar(idUser, CLAVE)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('solo account-service puede cerrar el acceso', () => {
      const controller = new InternalCierreController(cierre);
      expect(() => controller.cerrarAcceso({ idUser: randomUUID() }, { internalCaller: 'card' } as never)).toThrow(
        ForbiddenException,
      );
    });
  });
});
