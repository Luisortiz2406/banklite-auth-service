import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { AdminStaffService } from './admin-staff.service';
import { StaffUser } from './entities/staff-user.entity';

const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';

function setup(user: StaffUser) {
  const repo = {
    findOne: jest.fn(async () => user),
    manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn({ save: jest.fn() })) },
  };
  const config = { get: (key: string) => (key === 'STAFF_JWT_SECRET' ? SECRET : undefined) };
  const service = new AdminStaffService(
    repo as never,
    new JwtService({}),
    config as unknown as ConfigService,
    { record: jest.fn() } as unknown as AdminAuditService,
  );
  return { service };
}

const buildUser = (overrides: Partial<StaffUser> = {}) =>
  ({
    id: 'staff-1',
    username: 'laura.gomez',
    nombre: 'Laura Gómez',
    role: 'compliance',
    active: true,
    documentoHash: null,
    sessionsValidAfter: null,
    lockedUntil: null,
    ...overrides,
  }) as StaffUser;

const admin: StaffPrincipal = { id: 'admin-1', username: 'admin', role: 'admin', docHash: null, issuedAt: null };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const tokenOf = (user: StaffUser, issuedAt: number): StaffPrincipal => ({
  id: user.id,
  username: user.username,
  role: user.role,
  docHash: null,
  issuedAt,
});

describe('Cierre de sesiones del panel al desactivar o cambiar el rol', () => {
  it('una sesión vigente pasa', async () => {
    const user = buildUser();
    const { service } = setup(user);
    await expect(service.checkSession(tokenOf(user, nowSeconds()))).resolves.toBeUndefined();
  });

  it('al desactivar al empleado, su token anterior deja de servir', async () => {
    const user = buildUser();
    const { service } = setup(user);
    const oldToken = tokenOf(user, nowSeconds() - 60);

    await service.update(user.id, { active: false }, admin);

    expect(user.active).toBe(false);
    expect(user.sessionsValidAfter).toBeInstanceOf(Date);
    await expect(service.checkSession(oldToken)).rejects.toThrow(UnauthorizedException);
  });

  it('al cambiarle el rol, su token anterior deja de servir aunque siga activo', async () => {
    const user = buildUser({ role: 'support' });
    const { service } = setup(user);
    const oldToken = tokenOf(user, nowSeconds() - 60);

    await service.update(user.id, { role: 'compliance' }, admin);

    expect(user.role).toBe('compliance');
    await expect(service.checkSession(oldToken)).rejects.toThrow(/rol cambió/);
    // Un token anterior al cambio pero que ya traiga el rol nuevo tampoco sirve (lo cubre la fecha)
    await expect(service.checkSession({ ...oldToken, role: 'compliance' })).rejects.toThrow(
      /sesión del panel se cerró/,
    );
  });

  it('el token del nuevo ingreso (emitido después del cierre) sí sirve', async () => {
    const user = buildUser({ role: 'support' });
    const { service } = setup(user);
    await service.update(user.id, { role: 'compliance' }, admin);
    await expect(service.checkSession(tokenOf(user, nowSeconds()))).resolves.toBeUndefined();
  });

  it('cambiar solo la contraseña no cierra las sesiones', async () => {
    const user = buildUser();
    const { service } = setup(user);
    await service.update(user.id, { password: 'NuevaClaveSegura2026' }, admin);
    expect(user.sessionsValidAfter).toBeNull();
  });
});
