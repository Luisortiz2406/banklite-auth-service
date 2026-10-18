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
}
