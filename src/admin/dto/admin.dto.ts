import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { STAFF_ROLES, StaffRole } from '../../common/staff/staff-auth.guard';

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
const DOCUMENT_RULE = /^[0-9A-Za-z][0-9A-Za-z.\- ]{3,18}[0-9A-Za-z]$/;
const DOCUMENT_MESSAGE = 'El documento debe tener entre 5 y 20 caracteres (números y letras).';

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

  @IsIn(STAFF_ROLES)
  role: StaffRole;

  // Documento de identidad del empleado: con él, kyc-service le impide aprobar su
  // propia verificación. Solo se guarda su huella (staffDocHash), nunca el número.
  @IsOptional()
  @Matches(DOCUMENT_RULE, { message: DOCUMENT_MESSAGE })
  numeroDocumento?: string;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: StaffRole;

  @IsOptional()
  @Matches(DOCUMENT_RULE, { message: DOCUMENT_MESSAGE })
  numeroDocumento?: string;

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

/** Filtro de clientes del panel: activo, bloqueo temporal, suspendido o cancelado (cada cliente cae en uno). */
export class CustomersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['active', 'locked', 'disabled', 'closed'])
  status?: 'active' | 'locked' | 'disabled' | 'closed';
}
