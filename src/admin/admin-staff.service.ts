import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { CreateStaffDto, StaffLoginDto, UpdateStaffDto } from './dto/admin.dto';
import { StaffUser } from './entities/staff-user.entity';

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
// Hash para comparar cuando el usuario no existe: mismo costo de tiempo que uno real.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 12);

@Injectable()
export class AdminStaffService implements OnModuleInit {
  private readonly logger = new Logger('AdminStaff');

  constructor(
    @InjectRepository(StaffUser) private readonly staff: Repository<StaffUser>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Primer administrador: si no hay ningún empleado y están definidas
   * ADMIN_BOOTSTRAP_USERNAME y ADMIN_BOOTSTRAP_PASSWORD, se crea con rol admin.
   * Después, los demás empleados se crean desde el panel.
   */
  async onModuleInit() {
    const username = this.config.get<string>('ADMIN_BOOTSTRAP_USERNAME')?.trim().toLowerCase();
    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');
    if (!username || !password) return;
    if ((await this.staff.count()) > 0) return;
    if (password.length < 12) {
      this.logger.warn('ADMIN_BOOTSTRAP_PASSWORD debe tener al menos 12 caracteres; no se creó el administrador inicial.');
      return;
    }
    await this.staff.save(
      this.staff.create({ username, nombre: 'Administrador', passwordHash: await bcrypt.hash(password, 12), role: 'admin' }),
    );
    this.logger.log(`Administrador inicial '${username}' creado.`);
  }

  async login(dto: StaffLoginDto) {
    const user = await this.staff.findOne({ where: { username: dto.username.trim().toLowerCase() } });
    const valid = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !user.active) throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Usuario bloqueado temporalmente por intentos fallidos. Intenta en 15 minutos.');
    }
    if (!valid) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS);
        user.failedLoginAttempts = 0;
        this.logger.warn(`Empleado '${user.username}' bloqueado 15 min por intentos fallidos.`);
      }
      await this.staff.save(user);
      throw new UnauthorizedException('Usuario o contraseña incorrectos.');
    }

    Object.assign(user, { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() });
    await this.staff.save(user);
    const principal = this.principal(user);
    await this.audit.record(principal, { action: 'staff.login', targetType: 'staff', targetId: user.id });

    const accessToken = this.jwt.sign(
      { sub: user.id, type: 'staff', role: user.role, username: user.username },
      { algorithm: 'HS256', secret: this.staffSecret(), expiresIn: this.config.get('STAFF_JWT_EXPIRES_IN', '8h') },
    );
    return { accessToken, staff: this.publicStaff(user) };
  }

  async me(id: string) {
    const user = await this.staff.findOne({ where: { id } });
    if (!user || !user.active) throw new UnauthorizedException('Empleado inactivo.');
    return this.publicStaff(user);
  }

  async list() {
    const users = await this.staff.find({ order: { createdAt: 'ASC' } });
    return users.map((u) => this.publicStaff(u));
  }

  async create(dto: CreateStaffDto, actor: StaffPrincipal) {
    const username = dto.username.trim().toLowerCase();
    if (await this.staff.findOne({ where: { username } })) throw new ConflictException('Ya existe un empleado con ese usuario.');
    const user = await this.staff.manager.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(StaffUser, { username, nombre: dto.nombre.trim(), passwordHash: await bcrypt.hash(dto.password, 12), role: dto.role }),
      );
      await this.audit.record(actor, { action: 'staff.create', targetType: 'staff', targetId: saved.id, details: { username, role: dto.role } }, manager);
      return saved;
    });
    return this.publicStaff(user);
  }

  async update(id: string, dto: UpdateStaffDto, actor: StaffPrincipal) {
    const user = await this.staff.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Empleado no encontrado.');
    if (id === actor.id && (dto.active === false || (dto.role && dto.role !== user.role))) {
      throw new BadRequestException('No puedes desactivarte ni cambiar tu propio rol.');
    }
    const changes: Record<string, unknown> = {};
    if (dto.role && dto.role !== user.role) changes.role = user.role = dto.role;
    if (dto.active !== undefined && dto.active !== user.active) changes.active = user.active = dto.active;
    if (dto.password) {
      user.passwordHash = await bcrypt.hash(dto.password, 12);
      Object.assign(user, { failedLoginAttempts: 0, lockedUntil: null });
      changes.password = 'restablecida';
    }
    await this.staff.manager.transaction(async (manager) => {
      await manager.save(user);
      await this.audit.record(actor, { action: 'staff.update', targetType: 'staff', targetId: id, details: changes }, manager);
    });
    return this.publicStaff(user);
  }

  private staffSecret() {
    const secret = this.config.get<string>('STAFF_JWT_SECRET');
    if (!secret) throw new UnauthorizedException('El panel administrativo no está configurado (STAFF_JWT_SECRET).');
    return secret;
  }

  private principal(user: StaffUser): StaffPrincipal {
    return { id: user.id, username: user.username, role: user.role };
  }

  private publicStaff(u: StaffUser) {
    return {
      id: u.id,
      username: u.username,
      nombre: u.nombre,
      role: u.role,
      active: u.active,
      locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    };
  }
}
