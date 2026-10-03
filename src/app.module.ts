import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [UsuarioAuth, SesionActiva, EmailVerification, PhoneVerification, PasswordResetChallenge, EventOutbox, StaffUser, AdminAudit],
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
