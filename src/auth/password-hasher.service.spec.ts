import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import { PasswordHasher } from './password-hasher.service';

/**
 * Hash de la clave del cliente (PIN de 4 dígitos). Con bcrypt real: se verifica que
 * el pepper cambie el resultado (la base sola no sirve para probar PIN), que una clave
 * anterior al pepper se acepte y avise que hay que migrarla, y que un usuario
 * inexistente tarde lo mismo que uno real.
 */
const PEPPER = 'pepper-de-las-claves-para-pruebas-0123456789';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(new ConfigService({ PASSWORD_PEPPER: PEPPER }));

  it('sin PASSWORD_PEPPER no arranca', () => {
    expect(() => new PasswordHasher(new ConfigService({}))).toThrow('PASSWORD_PEPPER no está configurado');
  });

  it('guarda la clave con el esquema 2 (bcrypt sobre HMAC con pepper), nunca en claro', async () => {
    const { hash, version } = await hasher.hash('13571357');

    expect(version).toBe(2);
    expect(hash).not.toContain('13571357');
    expect(hash.startsWith('$2')).toBe(true);
    const peppered = createHmac('sha256', PEPPER).update('13571357').digest('base64');
    expect(await bcrypt.compare(peppered, hash)).toBe(true);
    // Sin el pepper (solo la base robada) la clave no se puede probar.
    expect(await bcrypt.compare('13571357', hash)).toBe(false);
  });

  it('acepta la clave correcta y rechaza la incorrecta', async () => {
    const { hash } = await hasher.hash('13571357');

    expect(await hasher.verify('13571357', hash, 2)).toEqual({ valid: true, needsUpgrade: false });
    expect(await hasher.verify('13571358', hash, 2)).toEqual({ valid: false, needsUpgrade: false });
  });

  it('con otro pepper la misma clave no coincide', async () => {
    const { hash } = await hasher.hash('13571357');
    const other = new PasswordHasher(new ConfigService({ PASSWORD_PEPPER: 'otro-pepper-distinto-0123456789abcdef' }));

    expect((await other.verify('13571357', hash, 2)).valid).toBe(false);
  });

  it('una clave guardada antes del pepper (esquema 1) entra y pide migrarla; si es incorrecta no', async () => {
    const legacy = await bcrypt.hash('13571357', 4);

    expect(await hasher.verify('13571357', legacy, 1)).toEqual({ valid: true, needsUpgrade: true });
    expect(await hasher.verify('00000000', legacy, 1)).toEqual({ valid: false, needsUpgrade: false });
  });

  it('un usuario inexistente (sin hash) siempre es inválido, y gasta una comparación como uno real', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');

    expect(await hasher.verify('13571357', null, 2)).toEqual({ valid: false, needsUpgrade: false });

    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });
});
