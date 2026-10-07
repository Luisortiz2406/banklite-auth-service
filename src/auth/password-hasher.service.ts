import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';

/** 1 = bcrypt(clave); 2 = bcrypt(HMAC-SHA256(PASSWORD_PEPPER, clave)). */
export type PasswordHashVersion = 1 | 2;

// Para comparar cuando el usuario no existe: mismo costo de tiempo que uno real,
// así la respuesta no revela qué usuarios existen.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 12);

/**
 * Hash de las claves de los clientes. La clave de la app es un PIN de 4 dígitos
 * (10.000 combinaciones): con solo bcrypt, quien robe la base los descifra todos
 * en segundos. Con el "pepper" (secreto fuera de la base, en una variable de
 * entorno) la base sola no sirve para probarlos.
 */
@Injectable()
export class PasswordHasher {
  private readonly pepper: string;

  // Obligatorio: sin pepper un PIN de 4 dígitos se descifra en segundos con la
  // base robada. validateEnv ya impide arrancar sin él; esto es la segunda barrera.
  constructor(config: ConfigService) {
    const pepper = config.get<string>('PASSWORD_PEPPER');
    if (!pepper) throw new Error('PASSWORD_PEPPER no está configurado.');
    this.pepper = pepper;
  }

  async hash(password: string): Promise<{ hash: string; version: PasswordHashVersion }> {
    return { hash: await bcrypt.hash(this.peppered(password), 12), version: 2 };
  }

  /** needsUpgrade: la clave es válida pero está guardada con un esquema anterior. */
  async verify(password: string, hash: string | null, version: number): Promise<{ valid: boolean; needsUpgrade: boolean }> {
    if (!hash) {
      await bcrypt.compare(password, DUMMY_HASH);
      return { valid: false, needsUpgrade: false };
    }
    if (version === 2) {
      return { valid: await bcrypt.compare(this.peppered(password), hash), needsUpgrade: false };
    }
    // Claves guardadas antes del pepper: se aceptan y se re-guardan con pepper.
    const valid = await bcrypt.compare(password, hash);
    return { valid, needsUpgrade: valid };
  }

  private peppered(password: string) {
    return createHmac('sha256', this.pepper).update(password).digest('base64');
  }
}
