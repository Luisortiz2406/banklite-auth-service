import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Ticket de cierre de cuenta: prueba de que el cliente confirmó con su clave y
 * un código por WhatsApp. Lo firma auth-service y lo verifica account-service
 * (que además lo marca como usado: un solo uso).
 *
 * Nunca es intercambiable con un token de acceso:
 *   - otro secreto (CLOSURE_TICKET_SECRET, distinto de JWT_SECRET);
 *   - otro tipo (type: 'closure_ticket') y audiencia (aud: 'account-service');
 * así un token de acceso no sirve como ticket ni un ticket como token de acceso,
 * aunque por error los dos secretos fueran iguales.
 */
export const CLOSURE_TICKET_TYPE = 'closure_ticket';
export const CLOSURE_TICKET_AUDIENCE = 'account-service';
export const CLOSURE_TICKET_TTL_SECONDS = 5 * 60;

export interface ClosureTicketPayload {
  sub: string;
  type: typeof CLOSURE_TICKET_TYPE;
  aud: typeof CLOSURE_TICKET_AUDIENCE;
  jti: string;
  iat: number;
  exp: number;
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest();

export function signClosureTicket(idUser: string, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload: ClosureTicketPayload = {
    sub: idUser,
    type: CLOSURE_TICKET_TYPE,
    aud: CLOSURE_TICKET_AUDIENCE,
    jti: randomUUID(),
    iat,
    exp: iat + CLOSURE_TICKET_TTL_SECONDS,
  };
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${unsigned}.${sign(unsigned, secret).toString('base64url')}`;
}

/** null si no es un ticket de cierre válido (firma, alg, tipo, audiencia o vencimiento). */
export function verifyClosureTicket(token: string, secret: string, now = Date.now()): ClosureTicketPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256') return null;
    const expected = sign(`${parts[0]}.${parts[1]}`, secret);
    const received = Buffer.from(parts[2], 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload?.type !== CLOSURE_TICKET_TYPE || payload?.aud !== CLOSURE_TICKET_AUDIENCE) return null;
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload as ClosureTicketPayload;
  } catch {
    return null;
  }
}
