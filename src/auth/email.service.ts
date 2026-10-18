import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { promises as dns } from 'dns';
import { Repository } from 'typeorm';
import { EmailVerification } from './entities/email-verification.entity';
import { GmailApiClient, readGmailCredentials } from './gmail-api.client';

const CODE_TTL_SECONDS = 5 * 60;

@Injectable()
export class EmailService {
  private readonly logger = new Logger('EmailService[auth-service]');
  private gmail: GmailApiClient | null = null;

  constructor(
    @InjectRepository(EmailVerification)
    private readonly verifications: Repository<EmailVerification>,
    private readonly config: ConfigService,
  ) {}

  private getGmail() {
    if (this.gmail) return this.gmail;
    const creds = readGmailCredentials((key) => this.config.get<string>(key));
    if (!creds) {
      throw new ServiceUnavailableException(
        'Gmail API no está configurada. Define GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN y GMAIL_SENDER.',
      );
    }
    this.gmail = new GmailApiClient(creds, 'GmailApiClient[auth-service]');
    return this.gmail;
  }

  /**
   * Comprueba que el dominio del correo tenga servidores MX.
   * Esto evita dominios inexistentes, pero no demuestra por sí solo que
   * el buzón concreto exista. La prueba definitiva es que el usuario
   * reciba y confirme el código enviado por correo.
   */
  private async validateEmailDomain(email: string) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) throw new BadRequestException('Correo electrónico inválido.');

    try {
      const mx = await dns.resolveMx(domain);
      if (!mx.length) {
        throw new BadRequestException('El dominio del correo no tiene servidores de correo válidos.');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('El dominio del correo no existe o no acepta correo electrónico.');
    }
  }

  async sendCode(idUser: string, email: string) {
    email = email.trim().toLowerCase();
    await this.validateEmailDomain(email);

    let row = await this.verifications.findOne({ where: { idUser } });

    // No se permite generar otro código para el MISMO correo mientras el anterior siga
    // vigente. Si la persona corrigió el correo, se le envía uno nuevo de inmediato.
    if (row && !row.verified && row.email === email && row.expiresAt.getTime() > Date.now()) {
      const remaining = Math.ceil((row.expiresAt.getTime() - Date.now()) / 1000);
      throw new ConflictException(
        `Tu codigo aún no se ha expirado o vencido. Espera ${remaining} segundos para solicitar otro.`,
      );
    }

    const code = String(randomInt(100000, 1000000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

    if (!row) {
      row = this.verifications.create({
        idUser,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        verified: false,
      });
    } else {
      Object.assign(row, {
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        verified: false,
      });
    }
    await this.verifications.save(row);

    try {
      await this.getGmail().send({
        to: email,
        subject: 'BankLite — Código de verificación',
        text: `Tu código de verificación BankLite es ${code}. Expira en 5 minutos.`,
        html: `<div style="font-family:Arial,sans-serif"><h2>BankLite</h2><p>Tu código de verificación es:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</div><p>Expira en 5 minutos.</p></div>`,
      });
    } catch (error) {
      // El código nunca llegó: se borra para que el usuario pueda pedir otro de inmediato
      // en vez de esperar a que venza uno que no recibió.
      await this.verifications.delete({ idUser });
      this.logger.error(`No se pudo enviar el código de verificación: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'No se pudo enviar el correo con el código. Verifica el correo e inténtalo nuevamente.',
      );
    }

    return {
      sent: true,
      email,
      expiresInSeconds: CODE_TTL_SECONDS,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Alerta de seguridad: se bloqueó el cambio de clave por intentos fallidos. */
  async sendRecoveryBlockedAlert(email: string, name: string, attempts: number) {
    const safeName = name.replace(/[<>&"]/g, '');
    const subject = '⚠️ [Acción requerida] Intentos de cambio de clave excedidos';
    const text = [
      `Hola, ${safeName}:`,
      '',
      `Hemos detectado ${attempts} intentos fallidos para cambiar la clave de tu cuenta BankLite. Como medida de seguridad, bloqueamos el cambio de clave. Se desbloquea automáticamente cuando ingreses con tu usuario y tu clave.`,
      '',
      '⚠️ ¿NO FUISTE TÚ?',
      'Si no has intentado cambiar tu clave, no te preocupes: tu cuenta sigue protegida y tu clave no cambió. Puedes ignorar este correo o contactar a nuestro equipo de soporte en ayuda@banklite.co si notas alguna actividad sospechosa.',
      '',
      'Atentamente,',
      'El equipo de seguridad de BankLite',
      '',
      'Este es un correo automático enviado por seguridad, por favor no respondas a este mensaje.',
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;color:#202824;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#18794e;margin:0 0 16px">BankLite</h2>
      <p>Hola, <b>${safeName}</b>:</p>
      <p>Hemos detectado <b>${attempts} intentos fallidos</b> para cambiar la clave de tu cuenta. Como medida de seguridad, <b>bloqueamos el cambio de clave</b>. Se desbloquea automáticamente cuando ingreses con tu usuario y tu clave.</p>
      <div style="background:#fff4e5;border-left:4px solid #e07b00;padding:12px 16px;margin:20px 0;border-radius:6px">
        <p style="margin:0 0 6px;font-weight:700">⚠️ ¿NO FUISTE TÚ?</p>
        <p style="margin:0">Si no has intentado cambiar tu clave, no te preocupes: tu cuenta sigue protegida y tu clave no cambió. Puedes ignorar este correo o contactar a nuestro equipo de soporte en <a href="mailto:ayuda@banklite.co">ayuda@banklite.co</a> si notas alguna actividad sospechosa.</p>
      </div>
      <p>Atentamente,<br>El equipo de seguridad de BankLite</p>
      <p style="color:#6b7a75;font-size:12px;margin-top:24px">Este es un correo automático enviado por seguridad, por favor no respondas a este mensaje.</p>
    </div>`;
    await this.getGmail().send({ to: email, subject, text, html });
  }

  async sendPasswordResetCode(email: string, code: string) {
    await this.validateEmailDomain(email);
    try {
      await this.getGmail().send({
        to: email,
        subject: 'BankLite — Código para cambiar tu clave',
        text: `Tu código para cambiar la clave de BankLite es ${code}. Expira en 5 minutos. Si no solicitaste este cambio, ignora este mensaje.`,
        html: `<div style="font-family:Arial,sans-serif;color:#202824;max-width:560px;margin:0 auto;padding:24px"><h2 style="color:#18794e">BankLite</h2><p>Usa este código de 6 dígitos para cambiar tu clave:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#17241e">${code}</p><p>El código expira en 5 minutos. Si no solicitaste este cambio, ignora este mensaje.</p></div>`,
      });
    } catch (error) {
      this.logger.error(`No se pudo enviar el código de recuperación: ${(error as Error).message}`);
      throw new ServiceUnavailableException('No se pudo enviar el código de recuperación por correo.');
    }
  }

  async verifyCode(idUser: string, email: string, code: string) {
    const row = await this.verifications.findOne({ where: { idUser } });
    if (!row || row.email.toLowerCase() !== email.toLowerCase()) {
      throw new BadRequestException('No existe un código pendiente para ese correo');
    }
    if (row.verified) return { verified: true };
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('El código ha expirado. Solicita un nuevo código.');
    }
    if (row.attempts >= 5) {
      throw new BadRequestException('Demasiados intentos. Solicita un nuevo código cuando expire el actual.');
    }

    row.attempts += 1;
    const valid = await bcrypt.compare(code, row.codeHash);
    if (!valid) {
      await this.verifications.save(row);
      throw new BadRequestException('Código de correo incorrecto');
    }
    row.verified = true;
    await this.verifications.save(row);
    return { verified: true };
  }

  async isVerified(idUser: string, email: string) {
    const row = await this.verifications.findOne({ where: { idUser } });
    return !!row && row.verified && row.email.toLowerCase() === email.toLowerCase();
  }
}
