import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StaffService } from './staff.service';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';
import {
  createStaffDepartmentSchema,
  updateStaffDepartmentSchema,
  createStaffPositionSchema,
  updateStaffPositionSchema,
  createStaffBranchSchema,
  updateStaffBranchSchema,
  assignStaffPositionSchema,
  updateStaffAssignmentSchema,
} from '@superapp/shared';

/**
 * Сервис «Сотрудники» (B2B): справочники Должность/Отдел/Филиал + назначения.
 * Тонкие хендлеры (Zod → сервис) — каждая операция вызываема программно (AI-ready).
 * Чтение — команда (роль ≥ Стажёр); запись — Менеджер и выше; Подрядчик изолирован.
 */
@ApiTags('Staff')
@ApiBearerAuth()
@Controller('workspaces/:id/staff')
export class StaffController {
  constructor(private staff: StaffService) {}

  @Get()
  @ApiOperation({ summary: 'Справочники: отделы + должности + филиалы (со счётчиками)' })
  async directory(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.staff.getDirectory(user.sub, id);
    return { success: true, data };
  }

  // ----- Отделы -----

  @Post('departments')
  @ApiOperation({ summary: 'Создать отдел (manager+)' })
  async createDepartment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = createStaffDepartmentSchema.parse(body);
    const dep = await this.staff.createDepartment(user.sub, id, data);
    return { success: true, data: dep };
  }

  @Patch('departments/:depId')
  @ApiOperation({ summary: 'Обновить отдел (manager+)' })
  async updateDepartment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('depId') depId: string,
    @Body() body: unknown,
  ) {
    const data = updateStaffDepartmentSchema.parse(body);
    await this.staff.updateDepartment(user.sub, id, depId, data);
    return { success: true };
  }

  @Delete('departments/:depId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить отдел (manager+; должности отцепляются)' })
  async deleteDepartment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('depId') depId: string,
  ) {
    await this.staff.deleteDepartment(user.sub, id, depId);
    return { success: true };
  }

  // ----- Должности -----

  @Post('positions')
  @ApiOperation({ summary: 'Создать должность (manager+)' })
  async createPosition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = createStaffPositionSchema.parse(body);
    const pos = await this.staff.createPosition(user.sub, id, data);
    return { success: true, data: pos };
  }

  @Patch('positions/:posId')
  @ApiOperation({ summary: 'Обновить должность (manager+)' })
  async updatePosition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('posId') posId: string,
    @Body() body: unknown,
  ) {
    const data = updateStaffPositionSchema.parse(body);
    await this.staff.updatePosition(user.sub, id, posId, data);
    return { success: true };
  }

  @Delete('positions/:posId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить должность (manager+; 409 если есть назначения)' })
  async deletePosition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('posId') posId: string,
  ) {
    await this.staff.deletePosition(user.sub, id, posId);
    return { success: true };
  }

  // ----- Филиалы -----

  @Post('branches')
  @ApiOperation({ summary: 'Создать филиал (manager+)' })
  async createBranch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = createStaffBranchSchema.parse(body);
    const br = await this.staff.createBranch(user.sub, id, data);
    return { success: true, data: br };
  }

  @Patch('branches/:brId')
  @ApiOperation({ summary: 'Обновить филиал (manager+)' })
  async updateBranch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('brId') brId: string,
    @Body() body: unknown,
  ) {
    const data = updateStaffBranchSchema.parse(body);
    await this.staff.updateBranch(user.sub, id, brId, data);
    return { success: true };
  }

  @Delete('branches/:brId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить филиал (manager+; 409 если там работают люди)' })
  async deleteBranch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('brId') brId: string,
  ) {
    await this.staff.deleteBranch(user.sub, id, brId);
    return { success: true };
  }

  // ----- Назначения должностей -----

  @Post('members/:userId/assignments')
  @ApiOperation({ summary: 'Назначить должность сотруднику (manager+)' })
  async assign(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() body: unknown,
  ) {
    const data = assignStaffPositionSchema.parse(body);
    const assignment = await this.staff.assignPosition(user.sub, id, targetUserId, data);
    return { success: true, data: assignment };
  }

  @Patch('assignments/:assignmentId')
  @ApiOperation({ summary: 'Изменить назначение: филиал/аттестация (manager+)' })
  async updateAssignment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
  ) {
    const data = updateStaffAssignmentSchema.parse(body);
    const assignment = await this.staff.updateAssignment(user.sub, id, assignmentId, data);
    return { success: true, data: assignment };
  }

  @Delete('assignments/:assignmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Снять назначение (manager+)' })
  async removeAssignment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    await this.staff.removeAssignment(user.sub, id, assignmentId);
    return { success: true };
  }
}
