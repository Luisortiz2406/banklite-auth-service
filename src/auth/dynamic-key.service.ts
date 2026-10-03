import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { UsuarioAuth } from './entities/usuario-auth.entity';

/**
 * Clave dinámica (token de software, como el de los bancos): código de 6
 * dígitos que cambia cada 60 segundos. Es un TOTP (RFC 6238, HMAC-SHA1) con
 * un secreto por usuario derivado de DYNAMIC_KEY_SECRET (o JWT_SECRET), así
 * que no se guarda ningún secreto en la base.
 *
 * - Transferencias dentro de Banklite: la app envía sola el código vigente y
 *   transfer-service lo valida aquí; la persona no lo escribe.
 * - Compras online en tiendas externas: ahí sí se escribe a mano.
 * - Un código vale durante su minuto (sirve para varias operaciones) y se
 *   acepta también el del minuto anterior por si cambió en el camino.
 * - 5 códigos incorrectos seguidos bloquean la clave dinámica 15 minutos.
 */
export const DYNAMIC_KEY_PERIOD_SECONDS = 60;
const DIGITS = 6;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

@Injectable()
export class DynamicKeyService {
  constructor(
    @InjectRepository(UsuarioAuth) private readonly usuarios: Repository<UsuarioAuth>,
    private readonly config: ConfigService,
  ) {}

  /** Código vigente para mostrar en la app. */
  current(idUser: string) {
    const now = Date.now();
    const step = this.stepAt(now);
    const expiresAt = (step + 1) * DYNAMIC_KEY_PERIOD_SECONDS * 1000;
    return {
      code: this.codeFor(idUser, step),
      period: DYNAMIC_KEY_PERIOD_SECONDS,
      secondsLeft: Math.ceil((expiresAt - now) / 1000),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Valida (y consume) un código. Lo llaman otros servicios por la red interna. */
  async verify(idUser: string, code: string): Promise<{ valid: boolean; message?: string }> {
    const user = await this.usuarios.findOne({ where: { idUser } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    if (user.dynamicKeyLockedUntil && user.dynamicKeyLockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('Clave dinámica bloqueada por intentos fallidos. Inténtalo de nuevo en 15 minutos.');
    }

    const current = this.stepAt(Date.now());
    const matched = [current, current - 1].find((step) => this.safeEqual(code, this.codeFor(idUser, step)));

    if (matched === undefined) {
      user.dynamicKeyFailures += 1;
      if (user.dynamicKeyFailures >= MAX_FAILURES) {
        user.dynamicKeyFailures = 0;
        user.dynamicKeyLockedUntil = new Date(Date.now() + LOCK_MS);
        await this.usuarios.save(user);
        throw new ForbiddenException('Superaste los intentos de clave dinámica. Quedó bloqueada 15 minutos.');
      }
      await this.usuarios.save(user);
      return { valid: false, message: 'Clave dinámica incorrecta o vencida.' };
    }

    user.dynamicKeyFailures = 0;
    user.dynamicKeyLockedUntil = null;
    await this.usuarios.save(user);
    return { valid: true };
  }

  private stepAt(ms: number): number {
    return Math.floor(ms / 1000 / DYNAMIC_KEY_PERIOD_SECONDS);
  }

  private secretFor(idUser: string): Buffer {
    const master = this.config.get<string>('DYNAMIC_KEY_SECRET') || this.config.get<string>('JWT_SECRET');
    if (!master) throw new Error('DYNAMIC_KEY_SECRET o JWT_SECRET deben estar configurados.');
    return createHmac('sha256', master).update(`banklite-dynamic-key:${idUser}`).digest();
  }

  /** HOTP (RFC 4226) sobre el paso de tiempo. */
  private codeFor(idUser: string, step: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = createHmac('sha1', this.secretFor(idUser)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return String(binary).padStart(DIGITS, '0');
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(String(a));
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
