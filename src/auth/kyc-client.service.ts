import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchWithRetry } from '../common/http/fetch-with-retry';

/**
 * Cliente HTTP interno hacia KYC Service. Auth Service no toca la base de KYC
 * (4.10 sin joins entre microservicios): solo pregunta si la identidad de un
 * idUser quedo verificada antes de crear sus credenciales. Tambien sincroniza
 * los datos de contacto verificados, sin acceder directamente a esa base.
 */
@Injectable()
export class KycClientService {
  constructor(private readonly config: ConfigService) {}

  async getIdentityStatus(idUser: string): Promise<{ verified: boolean; nombreCompleto: string | null }> {
    const baseUrl = this.config.get<string>('KYC_SERVICE_URL', 'http://localhost:3003');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Auth Service.');
    }

    try {
      const res = await fetchWithRetry(`${baseUrl}/kyc/status/${encodeURIComponent(idUser)}`, {
        headers: { 'x-internal-key': key },
      });
      if (!res.ok) throw new Error(`KYC respondió ${res.status}`);
      const body = (await res.json()) as { verified?: boolean; nombreCompleto?: string | null };
      return {
        verified: body.verified === true,
        nombreCompleto: body.nombreCompleto ?? null,
      };
    } catch {
      // Falla cerrado: si no se puede confirmar la identidad, no se crea la cuenta.
      throw new ServiceUnavailableException(
        'No se pudo confirmar la verificación de identidad. Inténtalo de nuevo en unos minutos.',
      );
    }
  }

  async updateVerifiedContact(idUser: string, contact: { email?: string; telefono?: string }): Promise<void> {
    const baseUrl = this.config.get<string>('KYC_SERVICE_URL', 'http://localhost:3003');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException('INTERNAL_API_KEY no esta configurada en Auth Service.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${baseUrl}/kyc/contact`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser, ...contact }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`KYC respondio ${res.status}`);
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo sincronizar el contacto verificado con KYC. Intentalo de nuevo.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
