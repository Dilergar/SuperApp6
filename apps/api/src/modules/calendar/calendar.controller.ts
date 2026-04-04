import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  createCalendarEventSchema,
  updateCalendarEventSchema,
  shareCalendarSchema,
} from '@superapp/shared';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(private calendarService: CalendarService) {}

  @Get('events')
  @ApiOperation({ summary: 'Получить события за период' })
  async getEvents(
    @CurrentUser() user: JwtPayload,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('types') types?: string,
    @Query('includeShared') includeShared?: string,
  ) {
    const events = await this.calendarService.getEvents(user.sub, from, to, {
      types: types?.split(','),
      includeShared: includeShared !== 'false',
    });
    return { success: true, data: events };
  }

  @Post('events')
  @ApiOperation({ summary: 'Создать событие' })
  async createEvent(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
  ) {
    const data = createCalendarEventSchema.parse(body);
    const event = await this.calendarService.createEvent(user.sub, data);
    return { success: true, data: event };
  }

  @Patch('events/:id')
  @ApiOperation({ summary: 'Обновить событие' })
  async updateEvent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = updateCalendarEventSchema.parse(body);
    const event = await this.calendarService.updateEvent(user.sub, id, data);
    return { success: true, data: event };
  }

  @Delete('events/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить событие' })
  async deleteEvent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.calendarService.deleteEvent(user.sub, id);
    return { success: true };
  }

  @Get('shares')
  @ApiOperation({ summary: 'Кому расшарен мой календарь' })
  async getShares(@CurrentUser() user: JwtPayload) {
    const shares = await this.calendarService.getShares(user.sub);
    return { success: true, data: shares };
  }

  @Post('shares')
  @ApiOperation({ summary: 'Расшарить календарь' })
  async shareCalendar(
    @CurrentUser() user: JwtPayload,
    @Body() body: { sharedWithUserId: string; permission: 'view' | 'edit' },
  ) {
    const data = shareCalendarSchema.parse(body);
    const share = await this.calendarService.shareCalendar(
      user.sub, data.sharedWithUserId, data.permission,
    );
    return { success: true, data: share };
  }

  @Delete('shares/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать доступ к календарю' })
  async unshareCalendar(
    @CurrentUser() user: JwtPayload,
    @Param('userId') sharedWithUserId: string,
  ) {
    await this.calendarService.unshareCalendar(user.sub, sharedWithUserId);
    return { success: true };
  }
}
