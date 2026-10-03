import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IsUUID, Matches } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { DynamicKeyService } from './dynamic-key.service';

class VerifyDynamicKeyDto {
  @IsUUID() idUser: string;
  @Matches(/^\d{6}$/, { message: 'La clave dinámica tiene 6 dígitos.' }) code: string;
}

@Controller()
export class DynamicKeyController {
  constructor(
    private readonly dynamicKeys: DynamicKeyService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** GET /auth/dynamic-key — clave dinámica vigente del usuario de la sesión. */
  @Get('auth/dynamic-key')
  current(@Headers('authorization') authorization?: string) {
    return this.dynamicKeys.current(this.userFromToken(authorization));
  }

  /**
   * POST /internal/dynamic-key/verify — solo servicio a servicio (x-internal-key).
   * El gateway no publica /internal.
   */
  @Post('internal/dynamic-key/verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyDynamicKeyDto, @Headers('x-internal-key') key?: string) {
    const expected = this.config.get<string>('INTERNAL_API_KEY');
    if (!expected || !key || key.length !== expected.length || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      throw new ForbiddenException('Acceso interno no autorizado.');
    }
    return this.dynamicKeys.verify(dto.idUser, dto.code);
  }

  private userFromToken(authorization?: string): string {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Token no proporcionado');
    try {
      const payload = this.jwt.verify(authorization.slice(7), { secret: this.config.get<string>('JWT_SECRET') });
      if (payload.type !== 'access' || !payload.sub) throw new Error();
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
