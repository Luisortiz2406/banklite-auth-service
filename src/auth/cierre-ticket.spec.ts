import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CLOSURE_TICKET_TTL_SECONDS, signClosureTicket, verifyClosureTicket } from './cierre-ticket';
import { ConsentimientosController } from './consentimientos.controller';

const CLOSURE_SECRET = 'secreto-del-ticket-de-cierre-0123456789abcdef';
const JWT_SECRET = 'secreto-de-los-tokens-de-cliente-0123456789ab';
const USER = '11111111-1111-4111-8111-111111111111';
const jwt = new JwtService({});
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Ticket de cierre', () => {
  it('un ticket recién emitido es válido 5 minutos, con tipo, audiencia y jti propios', () => {
    const now = Date.now();
    const payload = verifyClosureTicket(signClosureTicket(USER, CLOSURE_SECRET, now), CLOSURE_SECRET, now);
    expect(payload).toMatchObject({ sub: USER, type: 'closure_ticket', aud: 'account-service' });
    expect(payload!.exp - payload!.iat).toBe(CLOSURE_TICKET_TTL_SECONDS);
    expect(payload!.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(verifyClosureTicket(signClosureTicket(USER, CLOSURE_SECRET, now), CLOSURE_SECRET, now + 301_000)).toBeNull();
  });

  it('un TOKEN DE ACCESO no sirve como ticket (otro secreto y otro tipo)', () => {
    const access = jwt.sign({ sub: USER, type: 'access', cons: true }, { secret: JWT_SECRET, expiresIn: '15m' });
    expect(verifyClosureTicket(access, CLOSURE_SECRET)).toBeNull();
    // Aunque por error se firmara con el secreto del ticket, el tipo lo delata.
    const sameSecret = jwt.sign(
      { sub: USER, type: 'access', aud: 'account-service', jti: 'x' },
      { secret: CLOSURE_SECRET, expiresIn: '15m' },
    );
    expect(verifyClosureTicket(sameSecret, CLOSURE_SECRET)).toBeNull();
  });

  it('un TICKET no sirve como token de acceso (auth lo rechaza con 401)', async () => {
    const ticket = signClosureTicket(USER, CLOSURE_SECRET);
    const controller = (secret: string) =>
      new ConsentimientosController(
        { estado: async () => ({}) } as never,
        {} as never,
        {} as never,
        jwt,
        new ConfigService({ JWT_SECRET: secret }),
      );
    // Secretos distintos (lo normal): la firma no coincide.
    await expect(controller(JWT_SECRET).estado(`Bearer ${ticket}`)).rejects.toBeInstanceOf(UnauthorizedException);
    // Aunque por error los dos secretos fueran iguales: el tipo no es 'access'.
    await expect(controller(CLOSURE_SECRET).estado(`Bearer ${ticket}`)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza firma alterada, alg "none", otra audiencia y basura', () => {
    const [h, p] = signClosureTicket(USER, CLOSURE_SECRET).split('.');
    const otherUser = {
      ...JSON.parse(Buffer.from(p, 'base64url').toString()),
      sub: '22222222-2222-4222-8222-222222222222',
    };
    const tampered = `${h}.${b64(otherUser)}.${signClosureTicket(USER, CLOSURE_SECRET).split('.')[2]}`;
    expect(verifyClosureTicket(tampered, CLOSURE_SECRET)).toBeNull();
    expect(verifyClosureTicket(`${b64({ alg: 'none' })}.${p}.`, CLOSURE_SECRET)).toBeNull();
    const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...otherUser, sub: USER, aud: 'auth-service' })}`;
    const otherAud = `${unsigned}.${createHmac('sha256', CLOSURE_SECRET).update(unsigned).digest('base64url')}`;
    expect(verifyClosureTicket(otherAud, CLOSURE_SECRET)).toBeNull();
    expect(verifyClosureTicket('no-es-un-ticket', CLOSURE_SECRET)).toBeNull();
  });
});
