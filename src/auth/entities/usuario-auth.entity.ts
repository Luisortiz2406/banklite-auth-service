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

  // Nombre de usuario para iniciar sesión (minúsculas). Nulo en cuentas creadas
  // antes de que existiera: esas entran con su correo.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 30, nullable: true })
  username: string | null;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  // Esquema del hash (ver PasswordHasher): 1 = bcrypt, 2 = bcrypt con pepper.
  @Column({ name: 'password_hash_version', type: 'smallint', default: 1 })
  passwordHashVersion: number;

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

  // Recuperación de clave: intentos fallidos (dato que no es de la cuenta o
  // código equivocado). Al llegar al máximo se bloquea el cambio de clave hasta
  // que la persona vuelva a iniciar sesión.
  @Column({ name: 'recovery_failed_attempts', default: 0 })
  recoveryFailedAttempts: number;

  @Column({ name: 'recovery_blocked', default: false })
  recoveryBlocked: boolean;

  // Suspensión manual desde el panel administrativo (distinta del bloqueo
  // temporal por intentos fallidos): solo un empleado la puede levantar.
  @Column({ name: 'disabled_by_bank', default: false })
  disabledByBank: boolean;

  @Column({ name: 'disabled_reason', type: 'varchar', length: 300, nullable: true })
  disabledReason: string | null;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
