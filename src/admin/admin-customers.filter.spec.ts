import { randomUUID } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { SesionActiva } from '../auth/entities/sesion-activa.entity';
import { UsuarioAuth } from '../auth/entities/usuario-auth.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AdminCustomersService } from './admin-customers.service';
import { CustomersQueryDto } from './dto/admin.dto';

const HOUR = 60 * 60 * 1000;

/** Filtro de clientes del panel: cada cliente cae en un solo estado, igual que su etiqueta `access`. */
describeWithDb('Filtro de clientes del panel (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let service: AdminCustomersService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('auth_customers', [UsuarioAuth, SesionActiva]));
    service = new AdminCustomersService(
      dataSource.getRepository(UsuarioAuth),
      dataSource.getRepository(SesionActiva),
      {} as AdminAuditService,
    );
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const user = (email: string, overrides: Partial<UsuarioAuth> = {}) =>
    dataSource.getRepository(UsuarioAuth).save({
      idUser: randomUUID(),
      email,
      passwordHash: 'hash-de-prueba',
      ...overrides,
    } as Partial<UsuarioAuth>);

  async function seed() {
    const future = new Date(Date.now() + HOUR);
    await user('activo@banklite.test');
    await user('bloqueo-vencido@banklite.test', { blockedUntil: new Date(Date.now() - HOUR) });
    await user('bloqueado@banklite.test', { blockedUntil: future });
    await user('suspendido@banklite.test', { disabledByBank: true });
    await user('suspendido-y-bloqueado@banklite.test', { disabledByBank: true, blockedUntil: future });
    await user('cancelado@banklite.test', { closedAt: new Date() });
    // Canceló después de que el banco lo suspendiera y con un bloqueo temporal vigente: sigue siendo "cancelado".
    await user('cancelado-suspendido@banklite.test', {
      closedAt: new Date(),
      disabledByBank: true,
      blockedUntil: future,
    });
  }

  const emails = async (status?: string) =>
    (await service.list(undefined, status, 1, 50)).items.map((c) => c.email).sort();

  it('Cancelados: solo los que cancelaron su cuenta', async () => {
    await seed();
    expect(await emails('closed')).toEqual(['cancelado-suspendido@banklite.test', 'cancelado@banklite.test']);
  });

  it('Activos ya no incluye a los que cancelaron (ni a suspendidos o bloqueados)', async () => {
    await seed();
    expect(await emails('active')).toEqual(['activo@banklite.test', 'bloqueo-vencido@banklite.test']);
  });

  it('Suspendidos y Bloqueo temporal tampoco incluyen a los cancelados', async () => {
    await seed();
    expect(await emails('disabled')).toEqual(['suspendido-y-bloqueado@banklite.test', 'suspendido@banklite.test']);
    // Un suspendido con bloqueo vigente se muestra como "Suspendido": va en ese filtro, no aquí.
    expect(await emails('locked')).toEqual(['bloqueado@banklite.test']);
  });

  it('cada cliente cae en un solo filtro y coincide con su etiqueta', async () => {
    await seed();
    const all = await service.list(undefined, undefined, 1, 50);
    expect(all.total).toBe(7);
    for (const status of ['active', 'locked', 'disabled', 'closed']) {
      const page = await service.list(undefined, status, 1, 50);
      for (const c of page.items) expect(c.access).toBe(status);
    }
    const counts = await Promise.all(
      ['active', 'locked', 'disabled', 'closed'].map(async (s) => (await service.list(undefined, s, 1, 50)).total),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(7);
  });
});

describe('Parámetro status del listado de clientes', () => {
  const errors = async (status: string) =>
    validate(plainToInstance(CustomersQueryDto, { status }), { whitelist: true });

  it.each(['active', 'locked', 'disabled', 'closed'])('acepta %s', async (status) => {
    expect(await errors(status)).toHaveLength(0);
  });

  it('rechaza un estado desconocido', async () => {
    expect(await errors('cancelado')).not.toHaveLength(0);
  });
});
