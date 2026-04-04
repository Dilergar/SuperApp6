import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CirclesService } from './circles.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createCircleSchema,
  addCircleMemberSchema,
  updateCircleMemberSchema,
} from '@superapp/shared';

@ApiTags('Circles')
@ApiBearerAuth()
@Controller('circles')
export class CirclesController {
  constructor(private circlesService: CirclesService) {}

  @Get()
  @ApiOperation({ summary: 'Получить все окружения' })
  async getCircles(@CurrentUser() user: JwtPayload) {
    const circles = await this.circlesService.getCircles(user.sub);
    return { success: true, data: circles };
  }

  @Post()
  @ApiOperation({ summary: 'Создать окружение' })
  async createCircle(
    @CurrentUser() user: JwtPayload,
    @Body() body: { name: string; icon?: string; color?: string },
  ) {
    const data = createCircleSchema.parse(body);
    const circle = await this.circlesService.createCircle(user.sub, data);
    return { success: true, data: circle };
  }

  @Get('contacts')
  @ApiOperation({ summary: 'Все контакты из всех окружений' })
  async getAllContacts(@CurrentUser() user: JwtPayload) {
    const contacts = await this.circlesService.getAllContacts(user.sub);
    return { success: true, data: contacts };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Получить окружение с участниками' })
  async getCircle(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const circle = await this.circlesService.getCircle(user.sub, id);
    return { success: true, data: circle };
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Добавить участника в окружение' })
  async addMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') circleId: string,
    @Body() body: { contactPhone: string; contactName: string; role: string },
  ) {
    const data = addCircleMemberSchema.parse(body);
    const member = await this.circlesService.addMember(user.sub, circleId, data);
    return { success: true, data: member };
  }

  @Patch('members/:memberId')
  @ApiOperation({ summary: 'Обновить участника' })
  async updateMember(
    @CurrentUser() user: JwtPayload,
    @Param('memberId') memberId: string,
    @Body() body: { contactName?: string; role?: string },
  ) {
    const data = updateCircleMemberSchema.parse(body);
    const member = await this.circlesService.updateMember(user.sub, memberId, data);
    return { success: true, data: member };
  }

  @Delete('members/:memberId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить участника из окружения' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('memberId') memberId: string,
  ) {
    await this.circlesService.removeMember(user.sub, memberId);
    return { success: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить окружение' })
  async deleteCircle(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.circlesService.deleteCircle(user.sub, id);
    return { success: true };
  }
}
