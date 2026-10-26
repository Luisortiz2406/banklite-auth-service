import { IsEmail, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';

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
  // registro (fecha de "Última actualización" de privacidad.html). Opcional mientras
  // el frontend empieza a enviarla; si llega, debe ser la vigente.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'politicaVersion debe tener el formato AAAA-MM-DD.' })
  politicaVersion?: string;
}
