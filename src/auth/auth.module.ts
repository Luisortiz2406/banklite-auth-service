import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SesionActiva } from './entities/sesion-activa.entity';
import { UsuarioAuth } from './entities/usuario-auth.entity';
import { EmailVerification } from './entities/email-verification.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { EmailService } from './email.service';
import { KycClientService } from './kyc-client.service';
import { WhatsappOtpClientService } from './whatsapp-otp-client.service';
import { PasswordHasher } from './password-hasher.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([UsuarioAuth, SesionActiva, EmailVerification, PhoneVerification, PasswordResetChallenge]),
    JwtModule.register({}), // secreto/expiración se pasan por llamada (login/refresh)
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    EventPublisherService,
    EmailService,
    KycClientService,
    WhatsappOtpClientService,
    PasswordHasher,
  ],
  exports: [EventPublisherService],
})
export class AuthModule {}
