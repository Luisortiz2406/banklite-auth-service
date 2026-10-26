import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomInt, randomUUID } from 'crypto';
import { MoreThan, Repository } from 'typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { PasswordHasher } from './password-hasher.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';
import { EmailService } from './email.service';
import { documentosAceptados, POLITICA_DESACTUALIZADA, POLITICA_PRIVACIDAD_VIGENTE } from './consentimientos';
import { Consentimiento } from './entities/consentimiento.entity';
import { FraudClientService } from './fraud-client.service';
import { KycClientService } from './kyc-client.service';
import { PhoneVerification } from './entities/phone-verification.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { WhatsappOtpClientService } from './whatsapp-otp-client.service';

const MAX_INTENTOS_FALLIDOS = 5;
const DURACION_BLOQUEO_MS = 30 * 60 * 1000;
const PASSWORD_RESET_TTL_SECONDS = 5 * 60;
const PASSWORD_RESET_RESEND_SECONDS = 60;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
// Intentos fallidos de recuperación (dato ajeno o código malo) antes de bloquearla.
const MAX_RECOVERY_FAILURES = 3;
const RECOVERY_BLOCKED_MESSAGE =
  'Excediste tus intentos, tu cambio de clave fue bloqueado. Se desbloquea cuando inicies sesión.';
const REFRESH_TOKEN_DAYS = 7;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UsuarioAuth)
    private readonly usuarios: Repository<UsuarioAuth>,
    @InjectRepository(SesionActiva)
    private readonly sesiones: Repository<SesionActiva>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly events: EventPublisherService,
    private readonly hasher: PasswordHasher,
    private readonly emailService: EmailService,
    private readonly kycClient: KycClientService,
    private readonly whatsappOtp: WhatsappOtpClientService,
    private readonly fraudClient: FraudClientService,
    @InjectRepository(PhoneVerification)
    private readonly phones: Repository<PhoneVerification>,
    @InjectRepository(PasswordResetChallenge)
    private readonly passwordResetChallenges: Repository<PasswordResetChallenge>,
  ) {}

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Busca por correo sin distinguir mayúsculas (incluye filas antiguas guardadas con mayúsculas). */
  private findUserByEmail(email: string): Promise<UsuarioAuth | null> {
    return this.usuarios
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: this.normalizeEmail(email) })
      .getOne();
  }

  /**
   * Los refresh tokens son JWT largos y aleatorios: se guardan como SHA-256.
   * bcrypt no sirve aquí porque solo usa los primeros 72 bytes, que en un JWT
   * son casi idénticos para todos los tokens de un mismo usuario.
   */
  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async checkEmailAvailability(email: string) {
    const existing = await this.findUserByEmail(email);
    if (existing) {
      return { available: false, message: 'Correo eletronico registrado en otra cuenta' };
    }
    return { available: true };
  }

  async checkPhoneAvailability(phone: string) {
    const normalized = phone.trim();
    const existing = await this.phones.findOne({ where: { phone: normalized, verified: true } });
    if (existing) {
      return { available: false, message: 'Numero de telefono registrado en otra cuenta ' };
    }
    return { available: true };
  }

  async sendEmailVerification(idUser: string, email: string) {
    return this.emailService.sendCode(idUser, email);
  }

  async verifyEmailVerification(idUser: string, email: string, code: string) {
    const result = await this.emailService.verifyCode(idUser, email, code);
    await this.kycClient.updateVerifiedContact(idUser, { email: email.trim().toLowerCase() });
    return result;
  }

  async sendWhatsappVerification(idUser: string, phone: string) {
    return this.whatsappOtp.sendCode(idUser, phone.trim());
  }

  async verifyWhatsappVerification(idUser: string, phone: string, code: string) {
    const normalizedPhone = phone.trim();
    await this.whatsappOtp.verifyCode(idUser, normalizedPhone, code);

    const existingPhone = await this.phones.findOne({
      where: { phone: normalizedPhone, verified: true },
    });
    if (existingPhone && existingPhone.idUser !== idUser) {
      throw new ConflictException('Numero de telefono registrado en otra cuenta');
    }

    let row = await this.phones.findOne({ where: { idUser } });
    if (!row) {
      row = this.phones.create({
        idUser,
        phone: normalizedPhone,
        firebaseUid: null,
        verified: true,
      });
    } else {
      Object.assign(row, { phone: normalizedPhone, verified: true });
    }
    await this.phones.save(row);
    await this.kycClient.updateVerifiedContact(idUser, { telefono: normalizedPhone });
    return { verified: true, phone: normalizedPhone };
  }

  async contactVerificationStatus(idUser: string, email: string) {
    return {
      emailVerified: await this.emailService.isVerified(idUser, email),
      phoneVerified: !!(await this.phones.findOne({ where: { idUser, verified: true } })),
    };
  }

  /**
   * Cuenta a la que se le recupera la clave: por correo, o por el celular
   * verificado cuando el canal es WhatsApp. El correo sigue sirviendo en ambos
   * canales (lo usa el cambio de clave del dashboard).
   *
   * Con username (pantalla de ingreso), el correo o el celular deben ser
   * exactamente los registrados en esa cuenta; si no, se rechaza.
   */
  private async findUserForRecovery(
    target: { username?: string; email?: string; phone?: string },
    channel: 'email' | 'whatsapp',
  ): Promise<UsuarioAuth | null> {
    if (!target.email && !(channel === 'whatsapp' && target.phone)) {
      throw new BadRequestException(
        channel === 'email' ? 'Escribe tu correo registrado.' : 'Escribe tu número de celular registrado.',
      );
    }
    if (target.username) return this.findAccountMatchingContact(target, channel);
    let user: UsuarioAuth | null = null;
    if (target.email) user = await this.findUserByEmail(target.email);
    else if (channel === 'whatsapp' && target.phone) {
      const verified = await this.phones.findOne({ where: { phone: target.phone.trim(), verified: true } });
      user = verified ? await this.usuarios.findOne({ where: { idUser: verified.idUser } }) : null;
    }
    if (user?.recoveryBlocked) throw new ForbiddenException(RECOVERY_BLOCKED_MESSAGE);
    return user;
  }

  /**
   * Suma un intento fallido de recuperación. Al llegar al máximo bloquea el
   * cambio de clave (hasta el próximo inicio de sesión) y avisa por correo.
   * Devuelve true si la cuenta quedó bloqueada.
   */
  private async registerRecoveryFailure(user: UsuarioAuth): Promise<boolean> {
    user.recoveryFailedAttempts += 1;
    const blocked = user.recoveryFailedAttempts >= MAX_RECOVERY_FAILURES;
    if (blocked) user.recoveryBlocked = true;
    await this.usuarios.save(user);
    if (blocked) {
      await this.passwordResetChallenges.delete({ idUser: user.idUser });
      void this.sendRecoveryBlockedAlert(user);
    }
    return blocked;
  }

  private async sendRecoveryBlockedAlert(user: UsuarioAuth) {
    let name = user.username || 'cliente';
    try {
      name = (await this.kycClient.getIdentityStatus(user.idUser)).nombreCompleto || name;
    } catch {
      /* sin nombre de KYC se usa el usuario */
    }
    try {
      await this.emailService.sendRecoveryBlockedAlert(user.email, name, user.recoveryFailedAttempts);
    } catch (error) {
      this.logger.warn(`No se pudo enviar la alerta de bloqueo de recuperación: ${(error as Error).message}`);
    }
  }

  /** El dato escrito debe ser el registrado en la cuenta del usuario indicado. */
  private async findAccountMatchingContact(
    target: { username?: string; email?: string; phone?: string },
    channel: 'email' | 'whatsapp',
  ): Promise<UsuarioAuth> {
    const account = await this.usuarios.findOne({ where: { username: target.username!.trim().toLowerCase() } });
    if (account?.recoveryBlocked) throw new ForbiddenException(RECOVERY_BLOCKED_MESSAGE);

    let matches: boolean;
    let mismatchMessage: string;
    if (channel === 'whatsapp' && target.phone) {
      const verified = account
        ? await this.phones.findOne({ where: { idUser: account.idUser, verified: true } })
        : null;
      matches = !!verified && verified.phone === target.phone.trim();
      mismatchMessage = 'Este número no pertenece a tu cuenta.';
    } else {
      matches = !!account && this.normalizeEmail(account.email) === this.normalizeEmail(target.email!);
      mismatchMessage = 'Este correo no pertenece a tu cuenta.';
    }

    if (!account) throw new BadRequestException(mismatchMessage);
    if (!matches) {
      if (await this.registerRecoveryFailure(account)) throw new ForbiddenException(RECOVERY_BLOCKED_MESSAGE);
      throw new BadRequestException(mismatchMessage);
    }
    return account;
  }

  async requestPasswordReset(
    target: { username?: string; email?: string; phone?: string },
    channel: 'email' | 'whatsapp',
  ) {
    const user = await this.findUserForRecovery(target, channel);
    if (!user) return { accepted: true, expiresInSeconds: PASSWORD_RESET_TTL_SECONDS };
    const normalizedEmail = this.normalizeEmail(user.email);

    const now = new Date();
    const existing = await this.passwordResetChallenges.findOne({ where: { idUser: user.idUser } });
    if (
      existing &&
      existing.channel === channel &&
      existing.lastSentAt.getTime() + PASSWORD_RESET_RESEND_SECONDS * 1000 > now.getTime()
    ) {
      return { accepted: true, expiresInSeconds: PASSWORD_RESET_TTL_SECONDS };
    }

    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_SECONDS * 1000);
    let values: Partial<PasswordResetChallenge>;
    if (channel === 'email') {
      const code = String(randomInt(100000, 1000000));
      await this.emailService.sendPasswordResetCode(normalizedEmail, code);
      values = {
        idUser: user.idUser,
        channel,
        codeHash: await bcrypt.hash(code, 10),
        phone: null,
        expiresAt,
        lastSentAt: now,
        attempts: 0,
      };
    } else {
      const verifiedPhone = await this.phones.findOne({ where: { idUser: user.idUser, verified: true } });
      if (!verifiedPhone) return { accepted: true, expiresInSeconds: PASSWORD_RESET_TTL_SECONDS };
      await this.whatsappOtp.sendPasswordRecoveryCode(user.idUser, verifiedPhone.phone);
      values = {
        idUser: user.idUser,
        channel,
        codeHash: null,
        phone: verifiedPhone.phone,
        expiresAt,
        lastSentAt: now,
        attempts: 0,
      };
    }

    if (!existing) {
      await this.passwordResetChallenges.save(this.passwordResetChallenges.create(values));
    } else {
      Object.assign(existing, values);
      await this.passwordResetChallenges.save(existing);
    }
    return { accepted: true, expiresInSeconds: PASSWORD_RESET_TTL_SECONDS };
  }

  async resetPassword(
    target: { username?: string; email?: string; phone?: string },
    channel: 'email' | 'whatsapp',
    code: string,
    password: string,
  ) {
    if (!this.isSecureRegistrationPassword(password)) {
      throw new BadRequestException('Esta clave es insegura. Elige un PIN de 4 dígitos diferente.');
    }

    const user = await this.findUserForRecovery(target, channel);
    if (!user) throw new BadRequestException('Código inválido o vencido. Solicita uno nuevo.');

    const challenge = await this.passwordResetChallenges.findOne({ where: { idUser: user.idUser } });
    if (!challenge || challenge.channel !== channel) {
      throw new BadRequestException('Código inválido o vencido. Solicita uno nuevo.');
    }
    if (challenge.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('El código venció. Solicita uno nuevo.');
    }
    if (challenge.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      throw new BadRequestException('Superaste los intentos permitidos. Solicita un código nuevo.');
    }

    challenge.attempts += 1;
    let validCode = false;
    if (channel === 'email' && challenge.codeHash) {
      validCode = await bcrypt.compare(code, challenge.codeHash);
    } else if (channel === 'whatsapp' && challenge.phone) {
      try {
        const result = await this.whatsappOtp.verifyPasswordRecoveryCode(user.idUser, challenge.phone, code);
        validCode = result.verified === true;
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
      }
    }

    if (!validCode) {
      await this.passwordResetChallenges.save(challenge);
      if (await this.registerRecoveryFailure(user)) throw new ForbiddenException(RECOVERY_BLOCKED_MESSAGE);
      throw new BadRequestException('Código incorrecto o vencido.');
    }

    const hashed = await this.hasher.hash(password);
    user.passwordHash = hashed.hash;
    user.passwordHashVersion = hashed.version;
    user.failedLoginAttempts = 0;
    user.recoveryFailedAttempts = 0;
    user.status = 'active';
    user.blockedUntil = null;
    await this.usuarios.save(user);
    await this.sesiones.update({ idUser: user.idUser, activa: true }, { activa: false });
    await this.passwordResetChallenges.delete({ idUser: user.idUser });
    return { reset: true };
  }

  private isSecureRegistrationPassword(password: string): boolean {
    // El frontend usa el PIN de 4 dígitos duplicado para cumplir el mínimo
    // de 8 caracteres del backend. Validamos la clave original en ambos lados.
    if (!/^\d{8}$/.test(password)) return true;
    const pin = password.slice(0, 4);
    if (password.slice(4) !== pin) return true;
    if (/^(\d)\1{3}$/.test(pin)) return false;
    const digits = pin.split('').map(Number);
    const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
    const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
    const comunes = new Set(['1234', '4321', '0123', '3210', '2580', '0852']);
    return !ascending && !descending && !comunes.has(pin);
  }

  /** Crea las credenciales (clave hasheada con bcrypt). Exige identidad, correo y teléfono verificados. */
  async register(dto: RegisterDto) {
    // La versión aceptada debe ser la vigente: si la política cambió mientras el
    // cliente llenaba el registro, tiene que leerla y aceptarla de nuevo.
    if (dto.politicaVersion !== POLITICA_PRIVACIDAD_VIGENTE) {
      throw new BadRequestException(POLITICA_DESACTUALIZADA);
    }
    const email = this.normalizeEmail(dto.email);
    if (!this.isSecureRegistrationPassword(dto.password)) {
      throw new BadRequestException('Esta clave es insegura');
    }

    // El servidor no confía en el frontend: solo se crean credenciales para un
    // idUser cuya identidad (KYC), correo y teléfono ya fueron verificados.
    const correoVerificado = await this.emailService.isVerified(dto.idUser, email);
    if (!correoVerificado) {
      throw new BadRequestException('Debes verificar tu correo antes de crear la cuenta.');
    }
    const telefonoVerificado = await this.phones.findOne({
      where: { idUser: dto.idUser, verified: true },
    });
    if (!telefonoVerificado) {
      throw new BadRequestException('Debes verificar tu teléfono antes de crear la cuenta.');
    }
    // Identidad: se confirma con KYC Service (Verifik + Truora). Va al final para
    // no hacer la llamada de red si ya falló una comprobación local.
    const identity = await this.kycClient.getIdentityStatus(dto.idUser);
    if (!identity.verified) {
      throw new BadRequestException('Debes verificar tu identidad antes de crear la cuenta.');
    }

    if (await this.findUserByEmail(email)) {
      throw new ConflictException('Ya existe una cuenta con esos datos.');
    }

    const username = dto.username?.trim().toLowerCase() || null;
    if (username && (await this.usuarios.findOne({ where: { username } }))) {
      throw new ConflictException('Ese usuario ya está en uso. Elige otro.');
    }

    const hashed = await this.hasher.hash(dto.password);
    const usuario = this.usuarios.create({
      idUser: dto.idUser,
      email,
      username,
      passwordHash: hashed.hash,
      passwordHashVersion: hashed.version,
      mfaSecret: null,
      mfaEnabled: false,
      status: 'active',
      blockedUntil: null,
    });
    try {
      // Credenciales, aceptación de la política y evento en la misma transacción
      // (outbox transaccional): o se guarda todo o nada.
      await this.usuarios.manager.transaction(async (manager) => {
        await manager.save(usuario);
        const aceptadoEn = new Date();
        await manager.save(
          Consentimiento,
          documentosAceptados().map((doc) =>
            manager.create(Consentimiento, { idUser: usuario.idUser, ...doc, aceptadoEn }),
          ),
        );
        await this.events.publish(
          'account.created',
          {
            idUser: usuario.idUser,
            email: usuario.email,
            nombreCompleto: identity.nombreCompleto,
          },
          manager,
        );
      });
    } catch (error) {
      // PostgreSQL unique violation: idUser o correo ya tienen credenciales.
      if ((error as any)?.code === '23505') {
        throw new ConflictException('Ya existe una cuenta con esos datos.');
      }
      throw error;
    }
    void this.events.flush();

    return {
      idUser: usuario.idUser,
      email: usuario.email,
    };
  }

  /** POST /auth/username/check — disponibilidad del nombre de usuario en el registro. */
  async checkUsernameAvailability(username: string) {
    const exists = await this.usuarios.findOne({ where: { username: username.trim().toLowerCase() } });
    return { available: !exists };
  }

  /**
   * POST /auth/login — valida credenciales y entrega el access token directamente.
   * clientIp: la IP del cliente que pone el gateway (x-client-ip); solo se le
   * reporta a fraud-service (geolocalización), nunca se guarda ni se registra aquí.
   */
  async login(dto: LoginDto, clientIp?: string) {
    if (!dto.email && !dto.username) throw new BadRequestException('Ingresa tu usuario o tu correo.');
    const usuario = dto.username
      ? await this.usuarios.findOne({ where: { username: dto.username.trim().toLowerCase() } })
      : await this.findUserByEmail(dto.email as string);

    if (!usuario) {
      // Mismo tiempo de respuesta que con un usuario real: no revela cuáles existen.
      await this.hasher.verify(dto.password, null, 1);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (usuario.status === 'blocked') {
      if (usuario.blockedUntil && usuario.blockedUntil.getTime() > Date.now()) {
        throw new UnauthorizedException('Cuenta bloqueada temporalmente por intentos fallidos');
      }

      usuario.status = 'active';
      usuario.failedLoginAttempts = 0;
      usuario.blockedUntil = null;
      await this.usuarios.save(usuario);
    }

    const check = await this.hasher.verify(dto.password, usuario.passwordHash, usuario.passwordHashVersion);
    const passwordValida = check.valid;
    if (check.needsUpgrade) {
      // Migración transparente: la clave se vuelve a guardar con el esquema actual.
      const upgraded = await this.hasher.hash(dto.password);
      usuario.passwordHash = upgraded.hash;
      usuario.passwordHashVersion = upgraded.version;
    }

    if (!passwordValida) {
      usuario.failedLoginAttempts += 1;
      if (usuario.failedLoginAttempts >= MAX_INTENTOS_FALLIDOS) {
        usuario.status = 'blocked';
        usuario.blockedUntil = new Date(Date.now() + DURACION_BLOQUEO_MS);
      }
      await this.usuarios.manager.transaction(async (manager) => {
        await manager.save(usuario);
        await this.events.publish(
          'intento_fallido_login',
          {
            idUser: usuario.idUser,
            email: usuario.email,
            intentos: usuario.failedLoginAttempts,
            fechaHora: new Date().toISOString(),
          },
          manager,
        );
      });
      void this.events.flush();
      this.fraudClient.reportLogin({ idUser: usuario.idUser, ip: clientIp, outcome: 'failed' });

      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Suspensión manual del banco: se informa solo con la contraseña correcta,
    // para no revelar a terceros el estado de una cuenta.
    if (usuario.disabledByBank) {
      throw new ForbiddenException('Tu acceso fue suspendido por el banco. Comunícate con soporte.');
    }

    // Login correcto: resetea contador de intentos fallidos y desbloquea el
    // cambio de clave si se había bloqueado por intentos de recuperación.
    usuario.failedLoginAttempts = 0;
    usuario.blockedUntil = null;
    usuario.recoveryFailedAttempts = 0;
    usuario.recoveryBlocked = false;
    await this.usuarios.save(usuario);

    // Sesión activa (11.1 Autenticación y Sesión). Ya no hay segundo factor por app TOTP:
    // la cuenta se protege con la verificación de identidad, correo y teléfono del registro.
    const refreshTokenPlano = this.jwt.sign(
      // jti hace único cada refresh token aunque se emitan dos en el mismo segundo.
      { sub: usuario.idUser, type: 'refresh', jti: randomUUID() },
      {
        algorithm: 'HS256',
        secret: this.config.get('JWT_SECRET'),
        expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '7d'),
      },
    );
    const refreshTokenHash = this.hashRefreshToken(refreshTokenPlano);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_DAYS);

    const sesion = this.sesiones.create({
      idUser: usuario.idUser,
      refreshTokenHash,
      mfaVerified: true,
      activa: true,
      expiresAt,
    });
    await this.sesiones.manager.transaction(async (manager) => {
      await manager.save(sesion);
      await this.events.publish(
        'usuario_autenticado',
        {
          idUser: usuario.idUser,
          email: usuario.email,
          sessionId: sesion.id,
        },
        manager,
      );
    });
    void this.events.flush();
    this.fraudClient.reportLogin({ idUser: usuario.idUser, sessionId: sesion.id, ip: clientIp, outcome: 'success' });

    const accessToken = this.issueAccessToken(usuario.idUser);
    return {
      sessionId: sesion.id,
      accessToken,
      refreshToken: refreshTokenPlano,
    };
  }

  /** POST /auth/refresh-token — emite un nuevo access token sin repetir login. */
  async refreshToken(dto: RefreshTokenDto) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwt.verify(dto.refreshToken, {
        secret: this.config.get('JWT_SECRET'),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Token no es de tipo refresh');
    }

    const sesionValida = await this.sesiones.findOne({
      where: {
        idUser: payload.sub,
        refreshTokenHash: this.hashRefreshToken(dto.refreshToken),
        activa: true,
        expiresAt: MoreThan(new Date()),
      },
    });

    if (!sesionValida || !sesionValida.mfaVerified) {
      throw new UnauthorizedException('Sesión revocada, expirada o sin MFA verificado');
    }

    const usuario = await this.usuarios.findOne({ where: { idUser: payload.sub } });
    if (!usuario || usuario.disabledByBank) {
      throw new UnauthorizedException('El acceso de esta cuenta está suspendido.');
    }

    const accessToken = this.issueAccessToken(payload.sub);
    return { accessToken };
  }

  private issueAccessToken(idUser: string): string {
    return this.jwt.sign(
      { sub: idUser, type: 'access' },
      {
        algorithm: 'HS256',
        secret: this.config.get('JWT_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
      },
    );
  }
}
