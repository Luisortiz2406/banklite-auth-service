import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { POLITICA_DESACTUALIZADA } from '../consentimientos';
import { RegisterDto } from './register.dto';

/** Lo que ve el cliente cuando el registro llega sin la versión vigente (ValidationPipe une los mensajes). */
async function mensajes(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(RegisterDto, body));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('RegisterDto.politicaVersion (obligatoria)', () => {
  const valido = {
    idUser: '11111111-1111-4111-8111-111111111111',
    email: 'ana@banklite.test',
    username: 'ana',
    password: '13571357',
  };

  it('un registro.js viejo (sin politicaVersion) recibe solo el mensaje amable, una vez', async () => {
    expect(await mensajes(valido)).toEqual([POLITICA_DESACTUALIZADA]);
  });

  it('un formato raro también recibe el mensaje amable', async () => {
    expect(await mensajes({ ...valido, politicaVersion: 'ayer' })).toEqual([POLITICA_DESACTUALIZADA]);
  });

  it('con una fecha AAAA-MM-DD pasa la validación (la vigencia la revisa el servicio)', async () => {
    expect(await mensajes({ ...valido, politicaVersion: '2026-10-25' })).toEqual([]);
  });
});
