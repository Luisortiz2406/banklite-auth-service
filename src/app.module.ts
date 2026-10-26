import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CierreChallenge } from './auth/entities/cierre-challenge.entity';
import { Consentimiento } from './auth/entities/consentimiento.entity';
import { AuthModule } from './auth/auth.module';
import { SesionActiva } from './auth/entities/sesion-activa.entity';
import { UsuarioAuth } from './auth/entities/usuario-auth.entity';
import { EmailVerification } from './auth/entities/email-verification.entity';
import { PhoneVerification } from './auth/entities/phone-verification.entity';
import { PasswordResetChallenge } from './auth/entities/password-reset-challenge.entity';
import { EventOutbox } from './events/event-outbox.entity';
import { AdminModule } from './admin/admin.module';
import { StaffUser } from './admin/entities/staff-user.entity';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

const validateCommon = validateEnv(
  [
    { key: 'JWT_SECRET', type: 'secret' },
    { key: 'STAFF_JWT_SECRET', type: 'secret' },
    { key: 'DYNAMIC_KEY_SECRET', type: 'secret' },
    { key: 'PASSWORD_PEPPER', type: 'secret' },
    { key: 'INTERNAL_API_KEY', type: 'secret' },
    { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
    { key: 'DATABASE_URL', type: 'url' },
    { key: 'RABBITMQ_URL', type: 'url', optional: true },
  ],
  [
    'JWT_SECRET',
    'STAFF_JWT_SECRET',
    'DYNAMIC_KEY_SECRET',
    'PASSWORD_PEPPER',
    'INTERNAL_API_KEY',
    'CLOSURE_TICKET_SECRET',
  ],
);

function validateClosureSecret(config: Record<string, unknown>) {
  const secret = config.CLOSURE_TICKET_SECRET;
  if (typeof secret === 'string' && secret !== '') {
    if (secret !== secret.trim() || /^["']|["']$/.test(secret)) {
      throw new Error('CLOSURE_TICKET_SECRET tiene espacios o comillas al inicio o al final: escríbela sin ellos.');
    }
    if (secret.length < 32) throw new Error('CLOSURE_TICKET_SECRET debe tener al menos 32 caracteres aleatorios.');
  }
  return config;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // Comunes (env.validation.ts) y el secreto del ticket de cierre: opcional (sin él no
      // se puede cancelar la cuenta), pero si está debe ser fuerte y sin espacios.
      validate: (config) => validateClosureSecret(validateCommon(config)),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [
          UsuarioAuth,
          SesionActiva,
          EmailVerification,
          PhoneVerification,
          PasswordResetChallenge,
          Consentimiento,
          CierreChallenge,
          EventOutbox,
          StaffUser,
          AdminAudit,
        ],
        // synchronize=true es aceptable para desarrollo/demo académica;
        // en producción se usarían migraciones versionadas (ver 9.4 del doc).
        synchronize: true,
        logging: false,
      }),
    }),
    AuthModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
