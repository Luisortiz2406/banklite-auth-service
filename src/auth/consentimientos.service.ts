import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  documentosAceptados,
  POLITICA_DESACTUALIZADA,
  POLITICA_PRIVACIDAD_VIGENTE,
  TERMINOS_VIGENTES,
} from './consentimientos';
import { Consentimiento, DocumentoLegal } from './entities/consentimiento.entity';

export interface EstadoConsentimiento {
  // true si el cliente aceptó las versiones vigentes de privacidad Y términos.
  vigente: boolean;
  versionesVigentes: { privacidad: string; terminos: string };
  privacidad: { version: string; aceptadoEn: Date } | null;
  terminos: { version: string; aceptadoEn: Date } | null;
}

/**
 * Aceptación de la política de privacidad y de los términos por parte del
 * propio cliente. Nunca se rellena de forma automática: solo aceptar() crea
 * filas, y solo lo llama el cliente con su token (o el registro).
 */
@Injectable()
export class ConsentimientosService {
  constructor(@InjectRepository(Consentimiento) private readonly consentimientos: Repository<Consentimiento>) {}

  async estado(idUser: string): Promise<EstadoConsentimiento> {
    const filas = await this.consentimientos.find({ where: { idUser } });
    const vigente = (documento: DocumentoLegal, version: string) => {
      const fila = filas.find((f) => f.documento === documento && f.version === version);
      return fila ? { version: fila.version, aceptadoEn: fila.aceptadoEn } : null;
    };
    const privacidad = vigente('privacidad', POLITICA_PRIVACIDAD_VIGENTE);
    const terminos = vigente('terminos', TERMINOS_VIGENTES);
    return {
      vigente: !!privacidad && !!terminos,
      versionesVigentes: { privacidad: POLITICA_PRIVACIDAD_VIGENTE, terminos: TERMINOS_VIGENTES },
      privacidad,
      terminos,
    };
  }

  async tieneVigente(idUser: string): Promise<boolean> {
    return (await this.estado(idUser)).vigente;
  }

  /**
   * El cliente acepta las versiones vigentes (aceptado_en lo pone el servidor).
   * Idempotente: si ya las había aceptado, se conserva la fecha original.
   * Devuelve si esta llamada fue la que completó la aceptación.
   */
  async aceptar(idUser: string, politicaVersion: string): Promise<{ estado: EstadoConsentimiento; nueva: boolean }> {
    if (politicaVersion !== POLITICA_PRIVACIDAD_VIGENTE) throw new BadRequestException(POLITICA_DESACTUALIZADA);
    const antes = await this.tieneVigente(idUser);
    if (!antes) {
      const aceptadoEn = new Date();
      await this.consentimientos
        .createQueryBuilder()
        .insert()
        .into(Consentimiento)
        .values(documentosAceptados().map((doc) => ({ idUser, ...doc, aceptadoEn })))
        .orIgnore()
        .execute();
    }
    return { estado: await this.estado(idUser), nueva: !antes };
  }

  /** Para el panel (cumplimiento y administrador): todas las aceptaciones del cliente. */
  async historial(idUser: string) {
    const filas = await this.consentimientos.find({ where: { idUser }, order: { aceptadoEn: 'DESC' } });
    return {
      ...(await this.estado(idUser)),
      historial: filas.map((f) => ({ documento: f.documento, version: f.version, aceptadoEn: f.aceptadoEn })),
    };
  }
}
