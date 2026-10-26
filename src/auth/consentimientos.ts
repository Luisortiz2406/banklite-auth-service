import { DocumentoLegal } from './entities/consentimiento.entity';

/**
 * Versiones vigentes de los documentos que el cliente acepta en el registro
 * (fecha de "Última actualización" de privacidad.html y terminos.html del
 * frontend). Al cambiar un documento se actualiza aquí y en el frontend.
 */
export const POLITICA_PRIVACIDAD_VIGENTE = '2026-10-25';
export const TERMINOS_VIGENTES = '2026-10-01';

/** Filas a guardar cuando el cliente acepta la casilla del registro. */
export function documentosAceptados(): { documento: DocumentoLegal; version: string }[] {
  return [
    { documento: 'privacidad', version: POLITICA_PRIVACIDAD_VIGENTE },
    { documento: 'terminos', version: TERMINOS_VIGENTES },
  ];
}
