import { Body, Controller, Get, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Matches } from 'class-validator';
import { AuthService } from './auth.service';
import { POLITICA_DESACTUALIZADA } from './consentimientos';
import { ConsentimientosService } from './consentimientos.service';
import { FraudClientService } from './fraud-client.service';

export class AceptarConsentimientoDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: POLITICA_DESACTUALIZADA })
  politicaVersion: string;
}

/**
 * Aceptación de la política por los clientes que ya existían antes de que se
 * guardara (modal después del inicio de sesión). Solo con el token de acceso
 * del propio cliente. El api-gateway deja pasar estas rutas aunque el token no
 * tenga la marca de aceptación ("cons").
 */
@Controller('auth/consentimientos')
export class ConsentimientosController {
  constructor(
    private readonly consentimientos: ConsentimientosService,
    private readonly auth: AuthService,
    private readonly fraudClient: FraudClientService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Get('estado')
  async estado(@Headers('authorization') authorization?: string) {
    return this.consentimientos.estado(this.clienteDelToken(authorization));
  }

  /**
   * Guarda la aceptación (fecha del servidor, sin IP) y devuelve un token de
   * acceso nuevo con cons: true. Si esta llamada completó la aceptación, recién
   * ahora se reporta la sesión a fraud-service con la IP de esta petición: antes
   * de la autorización la IP no se procesa.
   */
  @Post()
  @HttpCode(200)
  async aceptar(
    @Body() dto: AceptarConsentimientoDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-client-ip') clientIp?: string,
  ) {
    const idUser = this.clienteDelToken(authorization);
    const { estado, nueva } = await this.consentimientos.aceptar(idUser, dto.politicaVersion);
    if (nueva) this.fraudClient.reportLogin({ idUser, ip: clientIp, outcome: 'success' });
    return { ...estado, accessToken: this.auth.issueAccessToken(idUser, estado.vigente) };
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
