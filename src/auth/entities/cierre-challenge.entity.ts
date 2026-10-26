import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Confirmación en curso para cancelar la cuenta: el cliente ya dio su clave y se
 * le envió un código por WhatsApp. Sin esta fila (o vencida) no se emite el
 * ticket de cierre. Se borra al emitir el ticket o al cerrar la cuenta.
 */
@Entity('cierre_challenges')
export class CierreChallenge {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // Cuándo dio la clave correcta (null si aún no la ha dado bien).
  @Column({ name: 'password_verified_at', type: 'timestamptz', nullable: true })
  passwordVerifiedAt: Date | null;

  @Column({ name: 'password_failures', type: 'int', default: 0 })
  passwordFailures: number;

  @Column({ name: 'otp_failures', type: 'int', default: 0 })
  otpFailures: number;

  // Tras 5 claves o códigos incorrectos, no se puede intentar hasta esta hora.
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
