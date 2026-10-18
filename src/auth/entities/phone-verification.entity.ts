import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('phone_verifications')
export class PhoneVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Index({ unique: true })
  @Column()
  phone: string;

  @Column({ name: 'firebase_uid', type: 'varchar', nullable: true })
  firebaseUid: string | null;

  @Column({ default: false })
  verified: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
