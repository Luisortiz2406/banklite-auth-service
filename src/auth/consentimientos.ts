import { DocumentoLegal } from './entities/consentimiento.entity';

/**
 * Versiones vigentes de los documentos que el cliente acepta en el registro
 * (fecha de "Última actualización" de privacidad.html y terminos.html del
 * frontend). Al cambiar un documento se actualiza aquí y en el frontend.
 */
export const POLITICA_PRIVACIDAD_VIGENTE = '2026-10-25';
export const TERMINOS_VIGENTES = '2026-10-01';

/**
 * Lo que ve el cliente si su registro no trae la versión vigente: falta (un
 * registro.js viejo en una pestaña abierta antes de un despliegue), tiene otro
 * formato o es una versión anterior. Siempre el mismo mensaje amable.
 */
export const POLITICA_DESACTUALIZADA =
  'La política de privacidad se actualizó. Recarga la página, revísala y acéptala de nuevo.';

/** Filas a guardar cuando el cliente acepta la casilla del registro. */
export function documentosAceptados(): { documento: DocumentoLegal; version: string }[] {
  return [
    { documento: 'privacidad', version: POLITICA_PRIVACIDAD_VIGENTE },
    { documento: 'terminos', version: TERMINOS_VIGENTES },
  ];
}
