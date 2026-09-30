import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface OtpResponse {
  sent?: boolean;
  verified?: boolean;
  phone?: string;
  expiresInSeconds?: number;
  expiresAt?: string;
}

@Injectable()
export class WhatsappOtpClientService {
  constructor(private readonly config: ConfigService) {}

  async sendCode(idUser: string, phone: string): Promise<OtpResponse> {
    return this.request('/otp/send', { idUser, phone });
  }

  async verifyCode(idUser: string, phone: string, code: string): Promise<OtpResponse> {
    return this.request('/otp/verify', { idUser, phone, code });
  }

  async sendPasswordRecoveryCode(idUser: string, phone: string): Promise<OtpResponse> {
    return this.request('/otp/password-reset/send', { idUser, phone });
  }

  async verifyPasswordRecoveryCode(idUser: string, phone: string, code: string): Promise<OtpResponse> {
    return this.request('/otp/password-reset/verify', { idUser, phone, code });
  }

  private async request(path: string, body: Record<string, string>): Promise<OtpResponse> {
    const baseUrl = this.config.get<string>(
      'NOTIFICATION_SERVICE_URL',
      'http://localhost:3005',
    );
    const internalKey = this.config.get<string>('INTERNAL_API_KEY');
    if (!internalKey) {
      throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Auth Service.');
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': internalKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo contactar al servicio de notificaciones.');
    }

    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.message === 'string'
        ? payload.message
        : 'El servicio de notificaciones rechazó la solicitud.';
      if (response.status >= 400 && response.status < 500) {
        throw new BadRequestException(message);
      }
      throw new ServiceUnavailableException(message);
    }
    return payload as OtpResponse;
  }
}
