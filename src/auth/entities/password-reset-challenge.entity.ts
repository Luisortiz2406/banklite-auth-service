import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('password_reset_challenges')
export class PasswordResetChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'varchar' })
  channel: 'email' | 'whatsapp';

  @Column({ name: 'code_hash', type: 'varchar', nullable: true })
  codeHash: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  phone: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt: Date;

  @Column({ default: 0 })
  attempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
