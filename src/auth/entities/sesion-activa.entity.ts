import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UsuarioAuth } from './usuario-auth.entity';

/**
 * Tabla sesiones_activas
 * Separada de usuarios_auth para poder revocar sesiones individualmente
 * sin tocar el registro de credenciales (4.6 Auth DB).
 */
@Entity('sesiones_activas')
export class SesionActiva {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => UsuarioAuth, { onDelete: 'CASCADE' })
  usuario: UsuarioAuth;

  @Index()
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // Nunca se almacena el refresh token en claro, solo su hash.
  @Index({ unique: true })
  @Column({ name: 'refresh_token_hash' })
  refreshTokenHash: string;

  @Column({ name: 'mfa_verified', default: false })
  mfaVerified: boolean;

  @Column({ default: true })
  activa: boolean;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
