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
  @ApiOperation({ summary: 'Шаблоны смен организации (+ объекта)' })
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
  @ApiOperation({ summary: 'Создать шаблон смены' })
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
  @ApiOperation({ summary: 'Изменить шаблон (уже поставленные смены не меняются)' })
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
  @ApiOperation({ summary: 'Убрать шаблон (архив)' })
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
  @ApiOperation({ summary: 'Ротации объекта (2/2, 5/2)' })
  async patterns(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
  ) {
    const data = await this.shifts.listPatterns(user.sub, workspaceId, objectId);
    return { success: true, data };
  }

  @Post('objects/:objectId/shift-patterns')
  @ApiOperation({ summary: 'Создать ротацию (сразу порождает смены на горизонт)' })
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
  @ApiOperation({ summary: 'Убрать ротацию (будущие черновики снимаются)' })
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
  @ApiOperation({ summary: 'Догенерировать смены по ротации (идемпотентно)' })
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
  @ApiOperation({ summary: 'Сетка смен объекта за период (черновики — только планировщику)' })
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
  @ApiOperation({ summary: 'Поставить смену' })
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
  @ApiOperation({ summary: 'Опубликовать график за период (дайджест сотрудникам)' })
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
  @ApiOperation({ summary: 'Табель объекта за период (свои строки — всем, чужие — управляющему)' })
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
  @ApiOperation({ summary: 'Исправить запись табеля (включая внеплановый выход)' })
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
  @ApiOperation({ summary: 'Удалить ошибочную запись табеля' })
  async attendanceRemove(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('attId') attId: string,
  ) {
    await this.attendance.remove(user.sub, workspaceId, attId);
    return { success: true, data: { ok: true } };
  }

  @Post('objects/:objectId/attendance')
  @ApiOperation({ summary: 'Внеплановый выход (смены в плане не было)' })
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
  @ApiOperation({ summary: 'Событие пропускной системы (source=access_control)' })
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
  @ApiOperation({ summary: 'Изменить смену (время, человек, заметка)' })
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
  @ApiOperation({ summary: 'Отменить смену' })
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
  @ApiOperation({ summary: '«Возьму»: занять открытую смену подходящей должности' })
  async takeShift(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('shiftId') shiftId: string,
  ) {
    const data = await this.shifts.take(user.sub, workspaceId, shiftId);
    return { success: true, data };
  }

  @Post('shifts/:shiftId/attendance')
  @ApiOperation({ summary: 'Отметить факт по смене (вышел / опоздал / не вышел)' })
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
