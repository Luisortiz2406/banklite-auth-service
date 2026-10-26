import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { CierreService } from './cierre.service';

export class IniciarCierreDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password: string;
}

export class ConfirmarCierreDto {
  @Matches(/^\d{4,8}$/, { message: 'El código tiene solo números.' })
  codigo: string;
}

export class CerrarAccesoDto {
  @IsUUID()
  idUser: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  cerradaEn?: Date;
}

/** Cancelar la cuenta (cliente, con su token de acceso): clave → código por WhatsApp → ticket de cierre. */
@Controller('auth/cierre')
export class CierreController {
  constructor(
    private readonly cierre: CierreService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('iniciar')
  @HttpCode(200)
  async iniciar(@Body() dto: IniciarCierreDto, @Headers('authorization') authorization?: string) {
    return this.cierre.iniciar(this.clienteDelToken(authorization), dto.password);
  }

  @Post('confirmar')
  @HttpCode(200)
  async confirmar(@Body() dto: ConfirmarCierreDto, @Headers('authorization') authorization?: string) {
    return this.cierre.confirmar(this.clienteDelToken(authorization), dto.codigo);
  }

  private clienteDelToken(authorization?: string): string {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Token no proporcionado');
    try {
      const payload = this.jwt.verify(authorization.slice(7), {
        secret: this.config.get<string>('JWT_SECRET'),
        algorithms: ['HS256'],
      });
      if (payload.type !== 'access' || !payload.sub) throw new Error();
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}

/** account-service, después de cerrar la cuenta: bloquear el acceso y revocar las sesiones. */
@Controller('internal/auth')
@UseGuards(InternalKeyGuard)
export class InternalCierreController {
  constructor(private readonly cierre: CierreService) {}

  @Post('cierre-acceso')
  @HttpCode(200)
  cerrarAcceso(@Body() dto: CerrarAccesoDto, @Req() request: Request) {
    if ((request as any).internalCaller !== 'account') {
      throw new ForbiddenException('Solo account-service puede cerrar el acceso de un cliente.');
    }
    return this.cierre.cerrarAcceso(dto.idUser, dto.cerradaEn);
  }
}
