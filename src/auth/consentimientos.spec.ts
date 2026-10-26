import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EventOutbox } from '../events/event-outbox.entity';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { POLITICA_DESACTUALIZADA, POLITICA_PRIVACIDAD_VIGENTE, TERMINOS_VIGENTES } from './consentimientos';
import { ConsentimientosService } from './consentimientos.service';
import { Consentimiento } from './entities/consentimiento.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';

/**
 * Registro con la aceptación de la política, contra un PostgreSQL real: la
 * cuenta, la aceptación y el evento account.created se guardan en la misma
 * transacción (o todo o nada). KYC, correo, teléfono y el hash se simulan.
 */
describeWithDb('Registro y aceptación de la política (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let service: AuthService;
  let failOutbox = false;

  // Publica en el outbox con el manager de la transacción, como el real; puede fallar a propósito.
  const events = {
    publish: jest.fn(async (routingKey: string, payload: Record<string, unknown>, manager: EntityManager) => {
      if (failOutbox) throw new Error('outbox caído');
      const repo = manager.getRepository(EventOutbox);
      await repo.save(repo.create({ routingKey, payload, occurredAt: new Date() }));
    }),
    flush: jest.fn(),
  };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('auth', [
      UsuarioAuth,
      SesionActiva,
      PhoneVerification,
      PasswordResetChallenge,
      Consentimiento,
      EventOutbox,
    ]));
    service = new AuthService(
      dataSource.getRepository(UsuarioAuth),
      dataSource.getRepository(SesionActiva),
      {} as never, // jwt (no se usa en el registro)
      {} as never, // config
      events as never,
      { hash: async () => ({ hash: 'hash-de-prueba', version: 2 }) } as never,
      { isVerified: async () => true } as never,
      { getIdentityStatus: async () => ({ verified: true, nombreCompleto: 'Ana Prueba' }) } as never,
      {} as never, // whatsappOtp
      { reportLogin: jest.fn() } as never,
      { findOne: async () => ({ verified: true }) } as never, // teléfono verificado
      dataSource.getRepository(PasswordResetChallenge),
      new ConsentimientosService(dataSource.getRepository(Consentimiento)),
    );
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    failOutbox = false;
    jest.clearAllMocks();
  });

  // Sin politicaVersion por defecto (como un registro.js viejo); cada prueba la agrega si la necesita.
  const dto = (overrides: Record<string, unknown> = {}) =>
    ({
      idUser: randomUUID(),
      email: `ana-${randomUUID().slice(0, 8)}@banklite.test`,
      username: `ana${randomUUID().slice(0, 6)}`,
      password: '13571357',
      ...overrides,
    }) as unknown as RegisterDto;
  const count = (entity: typeof UsuarioAuth | typeof Consentimiento | typeof EventOutbox) =>
    dataSource.getRepository(entity).count();

  it('con politicaVersion vigente guarda la cuenta y la aceptación de privacidad y términos', async () => {
    const before = Date.now();
    const input = dto({ politicaVersion: POLITICA_PRIVACIDAD_VIGENTE });
    await service.register(input);

    const rows = await dataSource.getRepository(Consentimiento).find({ order: { documento: 'ASC' } });
    expect(rows.map((r) => [r.idUser, r.documento, r.version])).toEqual([
      [input.idUser, 'privacidad', POLITICA_PRIVACIDAD_VIGENTE],
      [input.idUser, 'terminos', TERMINOS_VIGENTES],
    ]);
    // La fecha la pone el servidor, no el cliente.
    expect(rows[0].aceptadoEn.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await count(UsuarioAuth)).toBe(1);
  });

  it('la aceptación no guarda IP ni datos del navegador', () => {
    const columns = dataSource
      .getMetadata(Consentimiento)
      .columns.map((c) => c.databaseName)
      .sort();
    expect(columns).toEqual(['aceptado_en', 'documento', 'id', 'id_user', 'version']);
  });

  it('otra versión de la política: 400 y no se crea nada', async () => {
    await expect(service.register(dto({ politicaVersion: '2026-10-01' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(await count(UsuarioAuth)).toBe(0);
    expect(await count(Consentimiento)).toBe(0);
  });

  it('sin politicaVersion (registro.js viejo en caché): 400 con el mensaje amable y no se crea nada', async () => {
    await expect(service.register(dto())).rejects.toThrow(POLITICA_DESACTUALIZADA);
    expect(await count(UsuarioAuth)).toBe(0);
    expect(await count(Consentimiento)).toBe(0);
  });

  it('si algo falla en la transacción, no se guarda ni la cuenta ni la aceptación', async () => {
    failOutbox = true;
    await expect(service.register(dto({ politicaVersion: POLITICA_PRIVACIDAD_VIGENTE }))).rejects.toThrow(
      'outbox caído',
    );
    expect(await count(UsuarioAuth)).toBe(0);
    expect(await count(Consentimiento)).toBe(0);
    expect(await count(EventOutbox)).toBe(0);
  });

  it('una cuenta duplicada no deja aceptaciones sueltas', async () => {
    const input = dto({ politicaVersion: POLITICA_PRIVACIDAD_VIGENTE });
    await service.register(input);
    await expect(service.register({ ...input, username: 'otro' + input.username })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await count(UsuarioAuth)).toBe(1);
    expect(await count(Consentimiento)).toBe(2);
  });
});
