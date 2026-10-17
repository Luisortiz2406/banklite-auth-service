import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffPrincipal, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventPublisherService } from '../events/event-publisher.service';
import { AdminCustomersService } from './admin-customers.service';
import { AdminStaffService } from './admin-staff.service';
import { ChangeOwnPasswordDto, CreateStaffDto, PageQueryDto, ReasonDto, StaffLoginDto, UpdateStaffDto } from './dto/admin.dto';

const staffOf = (req: any): StaffPrincipal => req.staff;

/** Panel administrativo — empleados, clientes (credenciales) y auditoría de Auth Service. */
@Controller('auth/admin')
export class AdminController {
  constructor(
    private readonly staff: AdminStaffService,
    private readonly customers: AdminCustomersService,
    private readonly audit: AdminAuditService,
    private readonly events: EventPublisherService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: StaffLoginDto) {
    return this.staff.login(dto);
  }

  @Get('me')
  @UseGuards(StaffAuthGuard)
  me(@Req() req: any) {
    return this.staff.me(staffOf(req).id);
  }

  /** Cualquier empleado cambia su propia contraseña (exige la actual). */
  @Post('me/password')
  @HttpCode(200)
  @UseGuards(StaffAuthGuard)
  changeOwnPassword(@Body() dto: ChangeOwnPasswordDto, @Req() req: any) {
    return this.staff.changeOwnPassword(staffOf(req), dto.currentPassword, dto.newPassword);
  }

  @Get('staff')
  @UseGuards(StaffAuthGuard)
  @StaffRoles('admin')
  listStaff() {
    return this.staff.list();
  }

  @Post('staff')
  @UseGuards(StaffAuthGuard)
  @StaffRoles('admin')
  createStaff(@Body() dto: CreateStaffDto, @Req() req: any) {
    return this.staff.create(dto, staffOf(req));
  }

  @Patch('staff/:id')
  @UseGuards(StaffAuthGuard)
  @StaffRoles('admin')
  updateStaff(@Param('id') id: string, @Body() dto: UpdateStaffDto, @Req() req: any) {
    return this.staff.update(id, dto, staffOf(req));
  }

  @Get('customers')
  @UseGuards(StaffAuthGuard)
  listCustomers(@Query() q: PageQueryDto) {
    return this.customers.list(q.q, q.status, q.page ?? 1, q.limit ?? 25);
  }

  @Get('customers/:idUser')
  @UseGuards(StaffAuthGuard)
  customer(@Param('idUser') idUser: string) {
    return this.customers.detail(idUser);
  }

  @Post('customers/:idUser/disable')
  @HttpCode(200)
  @UseGuards(StaffAuthGuard)
  @StaffRoles('admin')
  disable(@Param('idUser') idUser: string, @Body() dto: ReasonDto, @Req() req: any) {
    return this.customers.disable(idUser, dto.reason, staffOf(req));
  }

  @Post('customers/:idUser/enable')
  @HttpCode(200)
  @UseGuards(StaffAuthGuard)
  @StaffRoles('admin')
  enable(@Param('idUser') idUser: string, @Body() dto: ReasonDto, @Req() req: any) {
    return this.customers.enable(idUser, dto.reason, staffOf(req));
  }

  @Get('audit')
  @UseGuards(StaffAuthGuard)
  auditLog(@Query() q: PageQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }

  @Get('outbox')
  @UseGuards(StaffAuthGuard)
  outbox() {
    return this.events.stats();
  }
}
