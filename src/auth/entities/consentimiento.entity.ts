import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DocumentoLegal = 'privacidad' | 'terminos';

/**
 * Prueba de la autorización del titular (Ley 1581 de 2012): qué documento y
 * qué versión aceptó cada cliente y cuándo. Solo eso: sin IP ni datos del
 * navegador. aceptado_en lo pone el servidor. Si una política cambia, se
 * agrega otra fila (la historia no se sobrescribe).
 */
@Entity('consentimientos')
@Index('uq_consentimientos_usuario_documento_version', ['idUser', 'documento', 'version'], { unique: true })
export class Consentimiento {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'varchar', length: 20 })
  documento: DocumentoLegal;

  // Fecha de "Última actualización" del documento (AAAA-MM-DD).
  @Column({ type: 'varchar', length: 20 })
  version: string;

  @Column({ name: 'aceptado_en', type: 'timestamptz' })
  aceptadoEn: Date;
}
