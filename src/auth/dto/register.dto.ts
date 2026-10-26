import { IsEmail, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';
import { POLITICA_DESACTUALIZADA } from '../consentimientos';

/**
 * Endpoint auxiliar para crear credenciales de prueba.
 * En producción, este registro lo dispararía el Identity Service
 * al completar el flujo de KYC (evento identity.verified), no un
 * endpoint público directo.
 */
export class RegisterDto {
  @IsUUID()
  idUser: string;

  @IsEmail()
  email: string;

  // Usuario para iniciar sesión; se guarda en minúsculas y es único.
  @IsOptional()
  @Matches(/^[a-zA-Z0-9._-]{3,30}$/, {
    message: 'El usuario debe tener de 3 a 30 letras, números, punto, guion o guion bajo.',
  })
  username?: string;

  @IsString()
  @MinLength(8)
  password: string;

  // Versión de la política de privacidad que el cliente aceptó en la casilla del
  // registro (fecha de "Última actualización" de privacidad.html). Obligatoria y debe
  // ser la vigente; si falta o no sirve, el cliente ve el mensaje amable de recargar.
  // Sin @IsOptional, @Matches también rechaza el campo ausente (un solo mensaje).
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: POLITICA_DESACTUALIZADA })
  politicaVersion: string;
}
