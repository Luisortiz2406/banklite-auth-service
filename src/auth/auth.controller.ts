import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, UsernameCheckDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MinLength } from 'class-validator';

class EmailSendDto { @IsUUID() idUser: string; @IsEmail() email: string; }
class EmailVerifyDto { @IsUUID() idUser: string; @IsEmail() email: string; @Matches(/^\d{6}$/) code: string; }
class WhatsappOtpSendDto {
  @IsUUID() idUser: string;
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone debe estar en formato internacional E.164' })
  phone: string;
}
class WhatsappOtpVerifyDto {
  @IsUUID() idUser: string;
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone debe estar en formato internacional E.164' })
  phone: string;
  @Matches(/^\d{6}$/, { message: 'code debe tener 6 dígitos' })
  code: string;
}
// Cada endpoint (/email/check, /phone/check) envía solo uno de los dos campos.
class ContactCheckDto { @IsOptional() @IsString() email?: string; @IsOptional() @IsString() phone?: string; }
class PasswordResetRequestDto {
  @IsEmail() email: string;
  @IsIn(['email', 'whatsapp']) channel: 'email' | 'whatsapp';
}
class PasswordResetDto {
  @IsEmail() email: string;
  @IsIn(['email', 'whatsapp']) channel: 'email' | 'whatsapp';
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' }) code: string;
  @IsString() @MinLength(8) password: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Endpoint auxiliar de pruebas, no forma parte del contrato original del doc.
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('username/check')
  @HttpCode(HttpStatus.OK)
  checkUsername(@Body() dto: UsernameCheckDto) {
    return this.authService.checkUsernameAvailability(dto.username);
  }

  @Post('email/check')
  @HttpCode(HttpStatus.OK)
  checkEmail(@Body() dto: ContactCheckDto) {
    if (!dto.email) return { available: true };
    return this.authService.checkEmailAvailability(dto.email);
  }

  @Post('email/send')
  @HttpCode(HttpStatus.OK)
  sendEmailCode(@Body() dto: EmailSendDto) {
    return this.authService.sendEmailVerification(dto.idUser, dto.email);
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  verifyEmailCode(@Body() dto: EmailVerifyDto) {
    return this.authService.verifyEmailVerification(dto.idUser, dto.email, dto.code);
  }

  @Post('phone/check')
  @HttpCode(HttpStatus.OK)
  checkPhone(@Body() dto: ContactCheckDto) {
    if (!dto.phone) return { available: true };
    return this.authService.checkPhoneAvailability(dto.phone);
  }

  @Post('whatsapp/send')
  @HttpCode(HttpStatus.OK)
  sendWhatsappCode(@Body() dto: WhatsappOtpSendDto) {
    return this.authService.sendWhatsappVerification(dto.idUser, dto.phone);
  }

  @Post('whatsapp/verify')
  @HttpCode(HttpStatus.OK)
  verifyWhatsappCode(@Body() dto: WhatsappOtpVerifyDto) {
    return this.authService.verifyWhatsappVerification(dto.idUser, dto.phone, dto.code);
  }

  @Post('verification-status')
  @HttpCode(HttpStatus.OK)
  verificationStatus(@Body() dto: EmailSendDto) {
    return this.authService.contactVerificationStatus(dto.idUser, dto.email);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('password-recovery/send')
  @HttpCode(HttpStatus.OK)
  requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    return this.authService.requestPasswordReset(dto.email, dto.channel);
  }

  @Post('password-recovery/reset')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: PasswordResetDto) {
    return this.authService.resetPassword(dto.email, dto.channel, dto.code, dto.password);
  }

  @Post('refresh-token')
  @HttpCode(HttpStatus.OK)
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto);
  }
}
