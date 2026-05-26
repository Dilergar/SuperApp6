import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ResourcesService } from './resources.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { createResourceSchema, updateResourceSchema } from '@superapp/shared';

@ApiTags('Resources')
@ApiBearerAuth()
@Controller('resources')
export class ResourcesController {
  constructor(private resources: ResourcesService) {}

  @Get()
  @ApiOperation({ summary: 'Мои ресурсы + те, что мне доступны для брони' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.resources.list(user.sub);
    return { success: true, data };
  }

  @Get('requests')
  @ApiOperation({ summary: 'Входящие заявки на бронь моих ресурсов' })
  async requests(@CurrentUser() user: JwtPayload) {
    const data = await this.resources.incomingRequests(user.sub);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать ресурс' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createResourceSchema.parse(body);
    const resource = await this.resources.create(user.sub, data);
    return { success: true, data: resource };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Обновить ресурс (владелец)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = updateResourceSchema.parse(body);
    const resource = await this.resources.update(user.sub, id, data);
    return { success: true, data: resource };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить ресурс (владелец)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.resources.remove(user.sub, id);
    return { success: true };
  }

  @Get(':id/schedule')
  @ApiOperation({ summary: 'Расписание ресурса за период' })
  async schedule(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const data = await this.resources.schedule(user.sub, id, from, to);
    return { success: true, data };
  }

  @Post('bookings/:eventId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Подтвердить бронь (владелец ресурса)' })
  async confirm(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    await this.resources.confirm(user.sub, eventId);
    return { success: true };
  }

  @Post('bookings/:eventId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отклонить бронь (владелец ресурса)' })
  async reject(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    await this.resources.reject(user.sub, eventId);
    return { success: true };
  }
}
