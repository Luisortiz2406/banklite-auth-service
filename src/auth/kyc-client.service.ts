import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS } from '../common/http/internal-http';

/**
 * Cliente HTTP interno hacia KYC Service. Auth Service no toca la base de KYC
 * (4.10 sin joins entre microservicios): solo pregunta si la identidad de un
 * idUser quedó verificada antes de crear sus credenciales. También sincroniza
 * los datos de contacto verificados, sin acceder directamente a esa base.
 * Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class KycClientService {
  constructor(private readonly config: ConfigService) {}

  async getIdentityStatus(idUser: string): Promise<{ verified: boolean; nombreCompleto: string | null }> {
    // Falla cerrado: si no se puede confirmar la identidad, no se crea la cuenta.
    const body = await callService<{ verified?: boolean; nombreCompleto?: string | null }>(
      `${this.baseUrl()}/kyc/status/${encodeURIComponent(idUser)}`,
      { headers: this.internalHeaders(), timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'KYC Service',
        internal: true,
        unavailable: 'No se pudo confirmar la verificación de identidad. Inténtalo de nuevo en unos minutos.',
      },
    );
    return { verified: body.verified === true, nombreCompleto: body.nombreCompleto ?? null };
  }

  async updateVerifiedContact(idUser: string, contact: { email?: string; telefono?: string }): Promise<void> {
    await callService(
      `${this.baseUrl()}/kyc/contact`,
      {
        method: 'PATCH',
        headers: { ...this.internalHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ idUser, ...contact }),
      },
      {
        service: 'KYC Service',
        internal: true,
        unavailable: 'No se pudo sincronizar el contacto verificado con KYC. Inténtalo de nuevo.',
      },
    );
  }

  private baseUrl() {
    return this.config.get<string>('KYC_SERVICE_URL', 'http://localhost:3003');
  }

  private internalHeaders() {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Auth Service.');
    return { 'x-internal-key': key };
  }
}
