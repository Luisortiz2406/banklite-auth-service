import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

/** Se inicia sesión con el nombre de usuario o con el correo (uno de los dos). */
export class LoginDto {
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z0-9._-]{3,30}$/, { message: 'Usuario inválido.' })
  username?: string;

  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  password: string;
}

export class UsernameCheckDto {
  @Matches(/^[a-zA-Z0-9._-]{3,30}$/, {
    message: 'El usuario debe tener de 3 a 30 letras, números, punto, guion o guion bajo.',
  })
  username: string;
}
