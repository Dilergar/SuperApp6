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
  assignToStaffingSchema,
  closeAssignmentSchema,
  createStaffingPositionSchema,
  setRateSchema,
  staffingQuerySchema,
  updateStaffingAssignmentSchema,
  updateStaffingPositionSchema,
} from '@superapp/shared';
import { StaffingService } from './staffing.service';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';

/** Штатное расписание объекта: единицы, назначения, версии ставок. */
@ApiTags('Objects · staffing')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId')
export class StaffingController {
  constructor(private staffing: StaffingService) {}

  @Get('objects/:objectId/staffing')
  @ApiOperation({ summary: 'Таблица штатного расписания за период (деньги — по правам)' })
  async table(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Query() query: unknown,
  ) {
    const q = staffingQuerySchema.parse(query ?? {});
    const period = q.period ?? new Date().toISOString().slice(0, 7);
    const data = await this.staffing.table(user.sub, workspaceId, objectId, period);
    return { success: true, data };
  }

  @Post('objects/:objectId/staffing/positions')
  @ApiOperation({ summary: 'Добавить штатную единицу (должность × объект)' })
  async createUnit(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = createStaffingPositionSchema.parse(body);
    const data = await this.staffing.createUnit(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Post('objects/:objectId/staffing/assign')
  @ApiOperation({ summary: 'Назначить человека на штатную единицу (со ставкой, одной транзакцией)' })
  async assign(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
  ) {
    const dto = assignToStaffingSchema.parse(body);
    const data = await this.staffing.assign(user.sub, workspaceId, objectId, dto);
    return { success: true, data };
  }

  @Patch('staffing/positions/:spId')
  @ApiOperation({ summary: 'Изменить штатную единицу' })
  async updateUnit(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('spId') spId: string,
    @Body() body: unknown,
  ) {
    const dto = updateStaffingPositionSchema.parse(body);
    await this.staffing.updateUnit(user.sub, workspaceId, spId, dto);
    return { success: true, data: { ok: true } };
  }

  @Delete('staffing/positions/:spId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать штатную единицу (архив; действующие назначения — 409)' })
  async archiveUnit(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('spId') spId: string,
  ) {
    await this.staffing.archiveUnit(user.sub, workspaceId, spId);
    return { success: true, data: { ok: true } };
  }

  @Post('staffing/positions/:spId/rates')
  @ApiOperation({ summary: 'Плановая ставка единицы с даты (закрывает предыдущую)' })
  async setUnitRate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('spId') spId: string,
    @Body() body: unknown,
  ) {
    const dto = setRateSchema.parse(body);
    const data = await this.staffing.setUnitRate(user.sub, workspaceId, spId, dto);
    return { success: true, data };
  }

  @Patch('staffing/assignments/:aId')
  @ApiOperation({ summary: 'Изменить назначение: даты, доля ставки' })
  async updateAssignment(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('aId') aId: string,
    @Body() body: unknown,
  ) {
    const dto = updateStaffingAssignmentSchema.parse(body);
    await this.staffing.updateAssignment(user.sub, workspaceId, aId, dto);
    return { success: true, data: { ok: true } };
  }

  @Post('staffing/assignments/:aId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Закрыть назначение датой (остаётся в истории)' })
  async closeAssignment(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('aId') aId: string,
    @Body() body: unknown,
  ) {
    const dto = closeAssignmentSchema.parse(body);
    await this.staffing.closeAssignment(user.sub, workspaceId, aId, dto);
    return { success: true, data: { ok: true } };
  }

  @Get('staffing/assignments/:aId/rates')
  @ApiOperation({ summary: 'История ставок назначения (только с правом на деньги)' })
  async rates(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('aId') aId: string,
  ) {
    const data = await this.staffing.listAssignmentRates(user.sub, workspaceId, aId);
    return { success: true, data };
  }

  @Post('staffing/assignments/:aId/rates')
  @ApiOperation({ summary: 'Фактическая ставка человека с даты (закрывает предыдущую)' })
  async setRate(
    @CurrentUser() user: JwtPayload,
    @Param('workspaceId') workspaceId: string,
    @Param('aId') aId: string,
    @Body() body: unknown,
  ) {
    const dto = setRateSchema.parse(body);
    const data = await this.staffing.setAssignmentRate(user.sub, workspaceId, aId, dto);
    return { success: true, data };
  }
}
