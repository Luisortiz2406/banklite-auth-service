import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class StaffLoginDto {
  @IsString()
  @MaxLength(40)
  username: string;

  @IsString()
  @MaxLength(200)
  password: string;
}

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/;
const PASSWORD_MESSAGE = 'La contraseña debe tener al menos 12 caracteres, con mayúsculas, minúsculas y números.';

export class CreateStaffDto {
  @Matches(/^[a-z0-9._-]{3,40}$/, {
    message: 'El usuario solo admite minúsculas, números, punto, guion y guion bajo (3 a 40).',
  })
  username: string;

  @IsString()
  @MinLength(3)
  @MaxLength(120)
  nombre: string;

  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  @IsIn(['support', 'admin'])
  role: 'support' | 'admin';
}

export class UpdateStaffDto {
  @IsOptional()
  @IsIn(['support', 'admin'])
  role?: 'support' | 'admin';

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password?: string;
}

/** Cambio de la contraseña propia (cualquier empleado). */
export class ChangeOwnPasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword: string;

  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  @MaxLength(200)
  newPassword: string;
}

export class ReasonDto {
  @IsString()
  @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' })
  @MaxLength(300)
  reason: string;
}

export class PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
