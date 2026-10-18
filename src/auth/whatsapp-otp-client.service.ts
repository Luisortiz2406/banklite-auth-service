import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS } from '../common/http/internal-http';

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

  // Errores: regla común de common/http/internal-http.ts (un 4xx de notificaciones,
  // como código incorrecto o vencido, llega al cliente con su estado y su mensaje).
  private async request(path: string, body: Record<string, string>): Promise<OtpResponse> {
    const baseUrl = this.config.get<string>('NOTIFICATION_SERVICE_URL', 'http://localhost:3005');
    const internalKey = this.config.get<string>('INTERNAL_API_KEY');
    if (!internalKey) {
      throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Auth Service.');
    }
    return callService<OtpResponse>(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey },
        body: JSON.stringify(body),
        timeoutMs: HTTP_TIMEOUTS.slow,
      },
      {
        service: 'Notification Service',
        internal: true,
        unavailable: 'No se pudo contactar al servicio de notificaciones. Inténtalo de nuevo.',
      },
    );
  }
}
