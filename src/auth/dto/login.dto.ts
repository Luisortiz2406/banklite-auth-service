import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  password: string;
}
