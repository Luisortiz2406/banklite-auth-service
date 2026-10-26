import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CLOSURE_TICKET_TTL_SECONDS, signClosureTicket } from './cierre-ticket';
import { CierreChallenge } from './entities/cierre-challenge.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';
import { PasswordHasher } from './password-hasher.service';
import { WhatsappOtpClientService } from './whatsapp-otp-client.service';

// La clave dada vale 10 min para confirmar con el código.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const tooMany = (until: Date) =>
  new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: `Demasiados intentos. Vuelve a intentarlo después de las ${until.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })}.`,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );

/**
 * Cancelar la cuenta, parte de auth-service:
 *   1. iniciar: el cliente da su clave → se le envía un código por WhatsApp;
 *   2. confirmar: da el código → recibe un ticket de cierre (5 min, un solo uso,
 *      secreto y tipo propios), que entrega a account-service junto con "CANCELAR";
 *   3. cerrarAcceso: account-service, ya cerrada la cuenta, bloquea aquí el
 *      inicio de sesión y revoca todas las sesiones (idempotente).
 */
@Injectable()
export class CierreService {
  constructor(
    @InjectRepository(UsuarioAuth) private readonly usuarios: Repository<UsuarioAuth>,
    @InjectRepository(SesionActiva) private readonly sesiones: Repository<SesionActiva>,
    @InjectRepository(PhoneVerification) private readonly phones: Repository<PhoneVerification>,
    @InjectRepository(PasswordResetChallenge) private readonly resets: Repository<PasswordResetChallenge>,
    @InjectRepository(CierreChallenge) private readonly challenges: Repository<CierreChallenge>,
    private readonly hasher: PasswordHasher,
    private readonly whatsapp: WhatsappOtpClientService,
    private readonly config: ConfigService,
  ) {}

  async iniciar(idUser: string, password: string) {
    this.ticketSecret(); // sin secreto configurado no se empieza nada
    const usuario = await this.cliente(idUser);
    const challenge = await this.challengeFor(idUser);

    const check = await this.hasher.verify(password, usuario.passwordHash, usuario.passwordHashVersion);
    if (!check.valid) {
      await this.fail(challenge, 'passwordFailures');
      throw new UnauthorizedException('La clave no es correcta.');
    }
    const phone = await this.phones.findOne({ where: { idUser, verified: true } });
    if (!phone) throw new BadRequestException('No tienes un celular verificado para recibir el código.');

    const sent = await this.whatsapp.sendCode(idUser, phone.phone);
    await this.challenges.save({ ...challenge, passwordVerifiedAt: new Date(), passwordFailures: 0, otpFailures: 0 });
    return {
      codigoEnviado: true,
      celular: this.mask(phone.phone),
      expiraEnSegundos: sent.expiresInSeconds ?? null,
    };
  }

  async confirmar(idUser: string, codigo: string) {
    const secret = this.ticketSecret();
    await this.cliente(idUser);
    const challenge = await this.challenges.findOne({ where: { idUser } });
    if (challenge?.lockedUntil && challenge.lockedUntil.getTime() > Date.now()) throw tooMany(challenge.lockedUntil);
    if (!challenge?.passwordVerifiedAt || Date.now() - challenge.passwordVerifiedAt.getTime() > CHALLENGE_TTL_MS) {
      throw new BadRequestException('Vuelve a escribir tu clave para recibir un código nuevo.');
    }
    const phone = await this.phones.findOne({ where: { idUser, verified: true } });
    if (!phone) throw new BadRequestException('No tienes un celular verificado para recibir el código.');

    try {
      await this.whatsapp.verifyCode(idUser, phone.phone, codigo);
    } catch (err) {
      // 4xx de notificaciones = código incorrecto o vencido: cuenta como intento fallido.
      if (err instanceof HttpException && err.getStatus() >= 400 && err.getStatus() < 500) {
        await this.fail(challenge, 'otpFailures');
      }
      throw err;
    }
    // El ticket solo se puede pedir una vez por clave + código.
    await this.challenges.delete({ idUser });
    return { ticket: signClosureTicket(idUser, secret), expiraEnSegundos: CLOSURE_TICKET_TTL_SECONDS };
  }

  /** account-service ya cerró la cuenta: sin inicio de sesión ni sesiones vivas. Idempotente. */
  async cerrarAcceso(idUser: string, cerradaEn?: Date) {
    const usuario = await this.usuarios.findOne({ where: { idUser } });
    if (!usuario) throw new NotFoundException('Cliente no encontrado.');
    if (!usuario.closedAt) {
      usuario.closedAt = cerradaEn ?? new Date();
      await this.usuarios.save(usuario);
    }
    await this.sesiones.update({ idUser, activa: true }, { activa: false });
    await this.resets.delete({ idUser });
    await this.challenges.delete({ idUser });
    return { cerrado: true, cerradaEn: usuario.closedAt };
  }

  private async cliente(idUser: string): Promise<UsuarioAuth> {
    const usuario = await this.usuarios.findOne({ where: { idUser } });
    if (!usuario) throw new UnauthorizedException('Token inválido o expirado');
    if (usuario.closedAt) throw new ForbiddenException('Tu cuenta ya fue cancelada.');
    if (usuario.disabledByBank)
      throw new ForbiddenException('Tu acceso fue suspendido por el banco. Comunícate con soporte.');
    return usuario;
  }

  private async challengeFor(idUser: string): Promise<CierreChallenge> {
    const existing = await this.challenges.findOne({ where: { idUser } });
    if (existing?.lockedUntil && existing.lockedUntil.getTime() > Date.now()) throw tooMany(existing.lockedUntil);
    return (
      existing ??
      this.challenges.create({
        idUser,
        passwordVerifiedAt: null,
        passwordFailures: 0,
        otpFailures: 0,
        lockedUntil: null,
      })
    );
  }

  private async fail(challenge: CierreChallenge, field: 'passwordFailures' | 'otpFailures') {
    challenge[field] += 1;
    if (challenge[field] >= MAX_FAILURES) {
      challenge.lockedUntil = new Date(Date.now() + LOCK_MS);
      challenge.passwordVerifiedAt = null;
      challenge.passwordFailures = 0;
      challenge.otpFailures = 0;
    }
    await this.challenges.save(challenge);
  }

  private ticketSecret(): string {
    const secret = this.config.get<string>('CLOSURE_TICKET_SECRET');
    if (!secret) throw new ServiceUnavailableException('La cancelación de cuentas no está disponible en este momento.');
    return secret;
  }

  private mask(phone: string): string {
    return phone.length > 4 ? `${'•'.repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}` : '••••';
  }
}
