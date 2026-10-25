import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'net';
import { requestService } from '../common/http/internal-http';

// Reporte sin esperar respuesta: si fraud-service tarda más, se abandona.
const REPORT_TIMEOUT_MS = 1_500;

export type LoginOutcome = 'success' | 'failed';

/**
 * Le avisa a fraud-service cada inicio de sesión con la IP del cliente (la pone
 * el gateway en x-client-ip) para la geolocalización por IP. Es una llamada
 * directa, no un evento: el outbox guardaría la IP para siempre. Nunca frena ni
 * rompe el inicio de sesión, y nunca escribe la IP en los logs.
 */
@Injectable()
export class FraudClientService {
  private readonly logger = new Logger(FraudClientService.name);

  constructor(private readonly config: ConfigService) {}

  /** No se espera: el inicio de sesión responde sin depender de fraud-service. */
  reportLogin(report: { idUser: string; sessionId?: string; ip?: string; outcome: LoginOutcome }): void {
    void this.send(report);
  }

  /** Devuelve si fraud-service recibió el reporte (para las pruebas). Nunca lanza. */
  async send(report: { idUser: string; sessionId?: string; ip?: string; outcome: LoginOutcome }): Promise<boolean> {
    const baseUrl = this.config.get<string>('FRAUD_SERVICE_URL')?.trim().replace(/\/+$/, '');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    const ip = report.ip?.trim();
    if (!baseUrl || !key || !ip || !isIP(ip)) return false;

    try {
      const response = await requestService(`${baseUrl}/internal/fraud/logins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({
          idUser: report.idUser,
          sessionId: report.sessionId,
          ip,
          outcome: report.outcome,
          occurredAt: new Date().toISOString(),
        }),
        timeoutMs: REPORT_TIMEOUT_MS,
      });
      if (!response) {
        this.logger.warn('fraud-service no respondió al reporte de inicio de sesión.');
        return false;
      }
      if (!response.ok) {
        this.logger.warn(`fraud-service rechazó el reporte de inicio de sesión (${response.status}).`);
        return false;
      }
      return true;
    } catch {
      this.logger.warn('No se pudo reportar el inicio de sesión a fraud-service.');
      return false;
    }
  }
}
