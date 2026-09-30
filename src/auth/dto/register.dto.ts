import { IsEmail, IsString, IsUUID, MinLength } from 'class-validator';

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

  @IsString()
  @MinLength(8)
  password: string;
}
