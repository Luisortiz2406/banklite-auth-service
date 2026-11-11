import { createHmac } from 'crypto';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { DYNAMIC_KEY_PERIOD_SECONDS, DynamicKeyService } from './dynamic-key.service';
import { DynamicKeyController } from './dynamic-key.controller';
import { UsuarioAuth } from './entities/usuario-auth.entity';

/**
 * Clave dinámica (TOTP de 6 dígitos, cambia cada 60 s). Con ella se confirman
 * transferencias y pagos, así que se prueba que el código sea el correcto (con
 * una implementación independiente del RFC 4226/6238), que un código vencido o
 * ajeno se rechace y que 5 fallos seguidos bloqueen 15 minutos.
 */

const MASTER = 'secreto-maestro-de-la-clave-dinamica-0123456789';
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 11, 12, 0, 0); // un instante exacto de inicio de minuto

/** Implementación de referencia, escrita aparte: secreto por usuario + HOTP (RFC 4226) sobre el paso de 60 s. */
function expectedCode(idUser: string, atMs: number, master = MASTER): string {
  const secret = createHmac('sha256', master).update(`banklite-dynamic-key:${idUser}`).digest();
  const step = Math.floor(atMs / 1000 / 60);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[19] & 0xf;
  const value =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}
const wrong = (idUser: string, atMs: number) =>
  String((Number(expectedCode(idUser, atMs)) + 1) % 1_000_000).padStart(6, '0');

describe('DynamicKeyService', () => {
  let users: Map<string, UsuarioAuth>;
  let service: DynamicKeyService;

  const user = (idUser: string): UsuarioAuth =>
    ({ idUser, dynamicKeyFailures: 0, dynamicKeyLockedUntil: null }) as unknown as UsuarioAuth;
  const build = (master: string | undefined = MASTER) => {
    const repo = {
      findOne: jest.fn(async ({ where }: { where: { idUser: string } }) => users.get(where.idUser) ?? null),
      save: jest.fn(async (row: UsuarioAuth) => row),
    };
    return {
      repo,
      service: new DynamicKeyService(
        repo as unknown as Repository<UsuarioAuth>,
        new ConfigService({ DYNAMIC_KEY_SECRET: master }),
      ),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START + 10_000); // 10 s dentro del minuto
    users = new Map([
      [ANA, user(ANA)],
      [CARLOS, user(CARLOS)],
    ]);
    service = build().service;
  });
  afterEach(() => jest.useRealTimers());

  describe('código vigente (current)', () => {
    it('es el TOTP de 6 dígitos del usuario para este minuto, con el tiempo que le queda', () => {
      const result = service.current(ANA);

      expect(result.code).toBe(expectedCode(ANA, START));
      expect(result.code).toMatch(/^\d{6}$/);
      expect(result).toMatchObject({ period: DYNAMIC_KEY_PERIOD_SECONDS, secondsLeft: 50 });
      expect(result.expiresAt).toBe(new Date(START + MINUTE).toISOString());
    });

    it('cambia en el minuto siguiente y no se repite entre usuarios', () => {
      const first = service.current(ANA).code;
      jest.setSystemTime(START + MINUTE + 1_000);

      expect(service.current(ANA).code).toBe(expectedCode(ANA, START + MINUTE));
      expect(service.current(ANA).code).not.toBe(first);
      expect(service.current(CARLOS).code).toBe(expectedCode(CARLOS, START + MINUTE));
      expect(service.current(CARLOS).code).not.toBe(service.current(ANA).code);
    });

    it('depende del secreto maestro: con otro DYNAMIC_KEY_SECRET sale otro código', () => {
      const other = build('otro-secreto-maestro-distinto-0123456789abc').service;
      expect(other.current(ANA).code).toBe(expectedCode(ANA, START, 'otro-secreto-maestro-distinto-0123456789abc'));
      expect(other.current(ANA).code).not.toBe(service.current(ANA).code);
    });

    it('sin DYNAMIC_KEY_SECRET no inventa uno: falla', () => {
      expect(() => build('').service.current(ANA)).toThrow('DYNAMIC_KEY_SECRET no está configurado');
    });

    it('al borde del minuto queda 1 segundo, no 0', () => {
      jest.setSystemTime(START + MINUTE - 100);
      expect(service.current(ANA).secondsLeft).toBe(1);
    });
  });

  describe('validar (verify)', () => {
    it('acepta el código vigente y también el del minuto anterior', async () => {
      await expect(service.verify(ANA, expectedCode(ANA, START))).resolves.toEqual({ valid: true });

      jest.setSystemTime(START + MINUTE + 5_000);
      const previous = expectedCode(ANA, START);
      await expect(service.verify(ANA, previous)).resolves.toEqual({ valid: true });
    });

    it('rechaza un código de hace dos minutos, uno de otro usuario, uno con otro formato y uno incorrecto', async () => {
      jest.setSystemTime(START + 2 * MINUTE + 5_000);
      const stale = expectedCode(ANA, START);
      const rejected = [stale, expectedCode(CARLOS, START + 2 * MINUTE), '12345', '1234567', 'abcdef', ''];

      for (const code of rejected) {
        users.get(ANA)!.dynamicKeyFailures = 0; // cada código se prueba aparte, sin llegar al bloqueo
        expect(await service.verify(ANA, code)).toEqual({
          valid: false,
          message: 'Clave dinámica incorrecta o vencida.',
        });
      }
    });

    it('el código del minuto siguiente tampoco vale (no se acepta el futuro)', async () => {
      const future = expectedCode(ANA, START + MINUTE);
      expect(future).not.toBe(expectedCode(ANA, START));
      expect(await service.verify(ANA, future)).toMatchObject({ valid: false });
    });

    it('un usuario que no existe da 404', async () => {
      await expect(service.verify('33333333-3333-4333-8333-333333333333', '123456')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cuenta los fallos, y un acierto los pone en cero', async () => {
      for (let i = 0; i < 3; i++) await service.verify(ANA, wrong(ANA, START));
      expect(users.get(ANA)!.dynamicKeyFailures).toBe(3);

      await service.verify(ANA, expectedCode(ANA, START));
      expect(users.get(ANA)!.dynamicKeyFailures).toBe(0);
      expect(users.get(ANA)!.dynamicKeyLockedUntil).toBeNull();
    });

    it('el quinto fallo seguido bloquea 15 minutos, aunque después llegue el código correcto', async () => {
      for (let i = 0; i < 4; i++) {
        expect(await service.verify(ANA, wrong(ANA, START))).toMatchObject({ valid: false });
      }
      await expect(service.verify(ANA, wrong(ANA, START))).rejects.toThrow('Quedó bloqueada 15 minutos');
      expect(users.get(ANA)!.dynamicKeyLockedUntil!.getTime()).toBe(Date.now() + 15 * MINUTE);

      // Bloqueada: ni el código correcto pasa y el bloqueo no se alarga por insistir.
      jest.setSystemTime(START + 10_000 + 5 * MINUTE);
      await expect(service.verify(ANA, expectedCode(ANA, Date.now()))).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.get(ANA)!.dynamicKeyLockedUntil!.getTime()).toBe(START + 10_000 + 15 * MINUTE);
    });

    it('pasados los 15 minutos vuelve a funcionar', async () => {
      for (let i = 0; i < 5; i++) await service.verify(ANA, wrong(ANA, START)).catch(() => undefined);

      jest.setSystemTime(START + 10_000 + 15 * MINUTE + 1_000);
      const now = Date.now();
      await expect(service.verify(ANA, expectedCode(ANA, now))).resolves.toEqual({ valid: true });
      expect(users.get(ANA)!.dynamicKeyLockedUntil).toBeNull();
    });

    it('el bloqueo de un usuario no afecta a otro', async () => {
      for (let i = 0; i < 5; i++) await service.verify(ANA, wrong(ANA, START)).catch(() => undefined);
      await expect(service.verify(CARLOS, expectedCode(CARLOS, START))).resolves.toEqual({ valid: true });
    });
  });
});

describe('DynamicKeyController', () => {
  const jwt = new JwtService({});
  const SECRET = 'secreto-de-clientes-para-pruebas-0123456789';
  const dynamicKeys = {
    current: jest.fn().mockReturnValue({ code: '123456' }),
    verify: jest.fn().mockResolvedValue({ valid: true }),
  };
  const controller = new DynamicKeyController(
    dynamicKeys as unknown as DynamicKeyService,
    jwt,
    new ConfigService({ JWT_SECRET: SECRET }),
  );
  const token = (payload: Record<string, unknown>, secret = SECRET) =>
    jwt.sign(payload, { secret, algorithm: 'HS256' });

  it('el código vigente se entrega al usuario del token de acceso, no a uno que mande el cliente', () => {
    expect(controller.current(`Bearer ${token({ sub: ANA, type: 'access' })}`)).toEqual({ code: '123456' });
    expect(dynamicKeys.current).toHaveBeenCalledWith(ANA);
  });

  it('sin token, o con un token de refresh, de otro secreto o sin sub, da 401', () => {
    expect(() => controller.current(undefined)).toThrow('Token no proporcionado');
    expect(() => controller.current('Basic abc')).toThrow(UnauthorizedException);
    for (const bad of [
      token({ sub: ANA, type: 'refresh' }),
      token({ type: 'access' }),
      token({ sub: ANA, type: 'access' }, 'otro-secreto-distinto-de-32-caracteres!!'),
      'no.es.jwt',
    ]) {
      expect(() => controller.current(`Bearer ${bad}`)).toThrow('Token inválido o expirado');
    }
  });

  it('validar es solo servicio a servicio (clave interna) y pasa usuario y código tal cual', async () => {
    const guards = Reflect.getMetadata('__guards__', DynamicKeyController.prototype.verify);
    expect(guards).toContain(InternalKeyGuard);

    expect(await controller.verify({ idUser: ANA, code: '123456' })).toEqual({ valid: true });
    expect(dynamicKeys.verify).toHaveBeenCalledWith(ANA, '123456');
  });
});
