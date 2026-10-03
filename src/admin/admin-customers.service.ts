import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, MoreThan, Repository } from 'typeorm';
import { SesionActiva } from '../auth/entities/sesion-activa.entity';
import { UsuarioAuth } from '../auth/entities/usuario-auth.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Credenciales de los clientes vistas desde el panel: búsqueda, detalle y suspensión. */
@Injectable()
export class AdminCustomersService {
  constructor(
    @InjectRepository(UsuarioAuth) private readonly usuarios: Repository<UsuarioAuth>,
    @InjectRepository(SesionActiva) private readonly sesiones: Repository<SesionActiva>,
    private readonly audit: AdminAuditService,
  ) {}

  async list(q?: string, status?: string, page = 1, limit = 25) {
    const qb = this.usuarios.createQueryBuilder('u').orderBy('u.createdAt', 'DESC');
    const term = q?.trim();
    if (term) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('u.email ILIKE :like', { like: `%${term}%` });
          if (UUID.test(term)) w.orWhere('u.idUser = :id', { id: term });
        }),
      );
    }
    if (status === 'disabled') qb.andWhere('u.disabledByBank = true');
    if (status === 'locked') qb.andWhere('u.blockedUntil > now()');
    if (status === 'active') qb.andWhere('u.disabledByBank = false').andWhere('(u.blockedUntil IS NULL OR u.blockedUntil <= now())');

    const take = Math.min(limit, 100);
    const [rows, total] = await qb.skip((page - 1) * take).take(take).getManyAndCount();
    return { items: rows.map((u) => this.publicCustomer(u)), total, page, limit: take };
  }

  async detail(idUser: string) {
    const user = await this.find(idUser);
    const [activeSessions, lastSession] = await Promise.all([
      this.sesiones.count({ where: { idUser, activa: true, expiresAt: MoreThan(new Date()) } }),
      this.sesiones.findOne({ where: { idUser }, order: { createdAt: 'DESC' } }),
    ]);
    return { ...this.publicCustomer(user), activeSessions, lastLoginAt: lastSession?.createdAt ?? null };
  }

  /** Suspende el acceso del cliente y cierra todas sus sesiones. */
  async disable(idUser: string, reason: string, actor: StaffPrincipal) {
    const user = await this.find(idUser);
    if (user.disabledByBank) throw new BadRequestException('El acceso del cliente ya está suspendido.');
    await this.usuarios.manager.transaction(async (manager) => {
      Object.assign(user, { disabledByBank: true, disabledReason: reason.trim(), disabledAt: new Date() });
      await manager.save(user);
      await manager.update(SesionActiva, { idUser, activa: true }, { activa: false });
      await this.audit.record(actor, { action: 'customer.disable', targetType: 'customer', targetId: idUser, reason }, manager);
    });
    return this.detail(idUser);
  }

  /** Levanta la suspensión y, de paso, el bloqueo temporal por intentos fallidos. */
  async enable(idUser: string, reason: string, actor: StaffPrincipal) {
    const user = await this.find(idUser);
    const wasLocked = !!user.blockedUntil && user.blockedUntil.getTime() > Date.now();
    if (!user.disabledByBank && !wasLocked) throw new BadRequestException('El acceso del cliente no está suspendido ni bloqueado.');
    await this.usuarios.manager.transaction(async (manager) => {
      Object.assign(user, {
        disabledByBank: false,
        disabledReason: null,
        disabledAt: null,
        status: 'active',
        failedLoginAttempts: 0,
        blockedUntil: null,
      });
      await manager.save(user);
      await this.audit.record(actor, { action: 'customer.enable', targetType: 'customer', targetId: idUser, reason, details: { wasLocked } }, manager);
    });
    return this.detail(idUser);
  }

  private async find(idUser: string) {
    if (!UUID.test(idUser)) throw new NotFoundException('Cliente no encontrado.');
    const user = await this.usuarios.findOne({ where: { idUser } });
    if (!user) throw new NotFoundException('Cliente no encontrado.');
    return user;
  }

  private publicCustomer(u: UsuarioAuth) {
    const locked = !!u.blockedUntil && u.blockedUntil.getTime() > Date.now();
    return {
      idUser: u.idUser,
      email: u.email,
      access: u.disabledByBank ? 'disabled' : locked ? 'locked' : 'active',
      failedLoginAttempts: u.failedLoginAttempts,
      lockedUntil: locked ? u.blockedUntil : null,
      disabledReason: u.disabledReason,
      disabledAt: u.disabledAt,
      createdAt: u.createdAt,
    };
  }
}
