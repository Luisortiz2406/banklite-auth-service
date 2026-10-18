import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { StaffRole } from '../../common/staff/staff-auth.guard';

/**
 * Empleados del banco que usan el panel administrativo. Separados de los
 * clientes (usuarios_auth): otra tabla, otro login y otro secreto de JWT.
 */
@Entity('staff_users')
export class StaffUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  username: string;

  @Column({ type: 'varchar', length: 120 })
  nombre: string;

  @Column({ name: 'password_hash', type: 'varchar' })
  passwordHash: string;

  @Column({ type: 'varchar', default: 'support' })
  role: StaffRole;

  // Huella del documento (staffDocHash), no el número. Null si no se registró.
  @Column({ name: 'documento_hash', type: 'varchar', length: 64, nullable: true })
  documentoHash: string | null;

  @Column({ default: true })
  active: boolean;

  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
