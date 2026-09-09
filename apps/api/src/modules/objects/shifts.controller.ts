import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  attendanceQuerySchema,
  createShiftSchema,
  gateEventSchema,
  markAttendanceSchema,
  publishShiftsSchema,
  shiftPatternSchema,
  shiftTemplateSchema,
  shiftTemplatesQuerySchema,
  shiftsQuerySchema,
  unplannedAttendanceSchema,
  updateAttendanceSchema,
  updateShiftSchema,
  updateShiftTemplateSchema,
} from '@superapp/shared';
import { ShiftsService } from './shifts.service';
import { AttendanceService } from './attendance.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';

/** График смен объекта: шаблоны, ротации, план и факт. */
@ApiTags('Objects · shifts')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId')
export class ShiftsController {
  constructor(
    private shifts: ShiftsService,
    private attendance: AttendanceService,
  ) {}

  // ---- Шаблоны (статические пути ДО :tplId) ----

  @Get('shift-templates')
  @ApiOperation({ summary: 'Shift templates of the organization (+ of the site)' })
  async templates(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Query() query?: unknown,
  ) {
    const { branchId } = shiftTemplatesQuerySchema.parse(query ?? {});
    const data = await this.shifts.listTemplates(user.sub, workspaceId, branchId);
    return { success: true, data };
  }

  @Post('shift-templates')
  @ApiOperation({ summary: 'Create a shift template' })
  async createTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const dto = shiftTemplateSchema.parse(body);
    const data = await this.shifts.createTemplate(user.sub, workspaceId, dto);
    return { success: true, data };
  }

  @Patch('shift-templates/:tplId')
  @ApiOperation({ summary: 'Change a template (the shifts already put on the board do not change)' })
  async updateTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('tplId') tplId: string,
    @Body() body: unknown,
  ) {
    const dto = updateShiftTemplateSchema.parse(body);
    const data = await this.shifts.updateTemplate(user.sub, workspaceId, tplId, dto);
    return { success: true, data };
  }

  @Delete('shift-templates/:tplId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a template (archive)' })
  async archiveTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('tplId') tplId: string,
  ) {
    await this.shifts.archiveTemplate(user.sub, workspaceId, tplId);
    return { success: true, data: { ok: true } };
  }

  // ---- Ротации ----

  @Get('objects/:objectId/shift-patterns')
  @ApiOperation({ summary: 'Rotations of the site (2/2, 5/2)' })
  async patterns(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.shifts.listPatterns(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Post('objects/:objectId/shift-patterns')
  @ApiOperation({ summary: 'Create a rotation (it spawns the shifts up to the horizon at once)' })
  async createPattern(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = shiftPatternSchema.parse(body);
    const data = await this.shifts.createPattern(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Delete('shift-patterns/:patId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a rotation (future drafts are taken off)' })
  async archivePattern(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('patId') patId: string,
  ) {
    await this.shifts.archivePattern(user.sub, workspaceId, patId);
    return { success: true, data: { ok: true } };
  }

  @Post('shift-patterns/:patId/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate the missing shifts of a rotation (idempotent)' })
  async generate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('patId') patId: string,
  ) {
    // Право на ВЕДЕНИЕ графика проверяет сервис (listPatterns проверял лишь право
    // видеть объект — рядовой сотрудник мог штамповать черновики).
    const created = await this.shifts.generate(user.sub, workspaceId, patId);
    return { success: true, data: { created } };
  }

  // ---- Смены ----

  @Get('objects/:objectId/shifts')
  @ApiOperation({ summary: 'The shift board of the site for a period (drafts — only for the planner)' })
  async board(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Query() query: unknown,
  ) {
    const q = shiftsQuerySchema.parse(query);
    const data = await this.shifts.board(user.sub, workspaceId, objectId, q.from, q.to);
    return { success: true, data };
  }

  @Post('objects/:objectId/shifts')
  @ApiOperation({ summary: 'Put a shift on the board' })
  async createShift(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = createShiftSchema.parse(body);
    const data = await this.shifts.create(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Post('objects/:objectId/shifts/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish the schedule for a period (a digest to the employees)' })
  async publish(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = publishShiftsSchema.parse(body);
    const data = await this.shifts.publish(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Get('objects/:objectId/attendance')
  @ApiOperation({ summary: 'The timesheet of the site for a period (own rows — to everybody, other rows — to the manager)' })
  async attendanceList(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Query() query: unknown,
  ) {
    const q = attendanceQuerySchema.parse(query ?? {});
    const data = await this.attendance.list(user.sub, workspaceId, objectId, q.from, q.to);
    return { success: true, data };
  }

  @Patch('attendance/:attId')
  @ApiOperation({ summary: 'Fix a timesheet record (including an unplanned attendance)' })
  async attendanceUpdate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('attId') attId: string,
    @Body() body: unknown,
  ) {
    const dto = updateAttendanceSchema.parse(body);
    const data = await this.attendance.update(user.sub, workspaceId, attId, dto);
    return { success: true, data };
  }

  @Delete('attendance/:attId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wrong timesheet record' })
  async attendanceRemove(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('attId') attId: string,
  ) {
    await this.attendance.remove(user.sub, workspaceId, attId);
    return { success: true, data: { ok: true } };
  }

  @Post('objects/:objectId/attendance')
  @ApiOperation({ summary: 'An unplanned attendance (there was no shift in the plan)' })
  async markUnplanned(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = unplannedAttendanceSchema.parse(body);
    const data = await this.attendance.markUnplanned(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Post('objects/:objectId/attendance/gate')
  @ApiOperation({ summary: 'An event of the access control system (source=access_control)' })
  async gate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = gateEventSchema.parse(body);
    const data = await this.attendance.recordGateEvent(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Patch('shifts/:shiftId')
  @ApiOperation({ summary: 'Change a shift (the time, the person, the note)' })
  async updateShift(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
    @Body() body: unknown,
  ) {
    const dto = updateShiftSchema.parse(body);
    const data = await this.shifts.update(user.sub, workspaceId, shiftId, dto);
    return { success: true, data };
  }

  @Post('shifts/:shiftId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a shift' })
  async cancelShift(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
  ) {
    const data = await this.shifts.cancel(user.sub, workspaceId, shiftId);
    return { success: true, data };
  }

  @Post('shifts/:shiftId/take')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '«I will take it»: take an open shift of a matching position' })
  async takeShift(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
  ) {
    const data = await this.shifts.take(user.sub, workspaceId, shiftId);
    return { success: true, data };
  }

  @Post('shifts/:shiftId/attendance')
  @ApiOperation({ summary: 'Mark the attendance of a shift (came in / late / no-show)' })
  async markAttendance(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
    @Body() body: unknown,
  ) {
    const dto = markAttendanceSchema.parse(body);
    const data = await this.attendance.markForShift(user.sub, workspaceId, shiftId, dto);
    return { success: true, data };
  }

}
