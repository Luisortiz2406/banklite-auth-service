import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SesionActiva } from '../auth/entities/sesion-activa.entity';
import { UsuarioAuth } from '../auth/entities/usuario-auth.entity';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { AdminCustomersService } from './admin-customers.service';
import { AdminStaffService } from './admin-staff.service';
import { AdminController } from './admin.controller';
import { StaffUser } from './entities/staff-user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([StaffUser, AdminAudit, UsuarioAuth, SesionActiva]),
    JwtModule.register({}),
    AuthModule,
  ],
  controllers: [AdminController],
  providers: [AdminStaffService, AdminCustomersService, AdminAuditService, StaffAuthGuard],
})
export class AdminModule {}
