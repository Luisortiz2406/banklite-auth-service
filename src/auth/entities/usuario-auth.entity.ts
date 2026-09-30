import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Tabla usuarios_auth
 * Guarda únicamente credenciales. Nunca contraseñas en texto plano
 * (11.1 Autenticación y Sesión / 11.5 Seguridad Adicional).
 */
@Entity('usuarios_auth')
export class UsuarioAuth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // id_user: referencia lógica al usuario en Identity DB (sin FK física,
  // ver 4.10 Integridad de Datos sin Joins entre Microservicios).
  @Index({ unique: true })
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Index({ unique: true })
  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ name: 'mfa_secret', type: 'varchar', nullable: true })
  mfaSecret: string | null;

  @Column({ name: 'mfa_enabled', default: false })
  mfaEnabled: boolean;

  @Column({
    type: 'varchar',
    default: 'active',
  })
  status: 'active' | 'blocked';

  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'blocked_until', type: 'timestamptz', nullable: true })
  blockedUntil: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
