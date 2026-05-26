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
  deleteCalendarEventSchema,
  calendarRangeSchema,
  inviteParticipantsSchema,
  rsvpSchema,
  setCalendarShareSchema,
  smartMatchSchema,
  myRemindersSchema,
} from '@superapp/shared';

@ApiTags('Calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(private calendarService: CalendarService) {}

  @Get('events')
  @ApiOperation({ summary: 'Календарь за период: события + слой задач + overlay чужих календарей' })
  async getRange(
    @CurrentUser() user: JwtPayload,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('layers') layers?: string,
    @Query('include') include?: string,
  ) {
    const q = calendarRangeSchema.parse({
      from,
      to,
      layers: layers ? layers.split(',') : undefined,
      include: include ? include.split(',') : undefined,
    });
    const data = await this.calendarService.getRange(user.sub, q.from, q.to, q.layers, q.include);
    return { success: true, data };
  }

  @Get('shared-with-me')
  @ApiOperation({ summary: 'Люди, чьи календари мне доступны (для слоёв)' })
  async sharedWithMe(@CurrentUser() user: JwtPayload) {
    const data = await this.calendarService.listSharedWithMe(user.sub);
    return { success: true, data };
  }

  @Post('smart-match')
  @ApiOperation({ summary: 'Подобрать общее свободное время (Smart Match)' })
  async smartMatch(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = smartMatchSchema.parse(body);
    const result = await this.calendarService.smartMatch(user.sub, data);
    return { success: true, data: result };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Детали события (с участниками)' })
  async getEvent(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.calendarService.getEventDetail(user.sub, id);
    return { success: true, data };
  }

  @Post('events')
  @ApiOperation({ summary: 'Создать событие (с участниками)' })
  async createEvent(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createCalendarEventSchema.parse(body);
    const event = await this.calendarService.createEvent(user.sub, data);
    return { success: true, data: event };
  }

  @Patch('events/:id')
  @ApiOperation({ summary: 'Обновить событие (editScope: this | this_and_following | all)' })
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
  @ApiOperation({ summary: 'Удалить событие или экземпляр серии' })
  async deleteEvent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('editScope') editScope?: string,
    @Query('occurrenceStart') occurrenceStart?: string,
  ) {
    const opts = deleteCalendarEventSchema.parse({ editScope, occurrenceStart });
    await this.calendarService.deleteEvent(user.sub, id, opts);
    return { success: true };
  }

  // ---- Participants & RSVP ----

  @Post('events/:id/participants')
  @ApiOperation({ summary: 'Пригласить участников (человек или Группа из окружения)' })
  async invite(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = inviteParticipantsSchema.parse(body);
    const added = await this.calendarService.inviteParticipants(user.sub, id, data);
    return { success: true, data: { added } };
  }

  @Delete('events/:id/participants/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать участника (организатор) или выйти (сам)' })
  async removeParticipant(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.calendarService.removeParticipant(user.sub, id, userId);
    return { success: true };
  }

  @Post('events/:id/rsvp')
  @ApiOperation({ summary: 'Ответить на приглашение (accepted | declined | tentative)' })
  async rsvp(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = rsvpSchema.parse(body);
    await this.calendarService.rsvp(user.sub, id, data.status);
    return { success: true };
  }

  @Post('events/:id/reminders')
  @ApiOperation({ summary: 'Мои напоминания по событию' })
  async setMyReminders(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = myRemindersSchema.parse(body);
    await this.calendarService.setMyReminders(user.sub, id, data.offsets);
    return { success: true };
  }

  // ---- Sharing (per-person; per-group lives on circles) ----

  @Get('shares')
  @ApiOperation({ summary: 'Кому я открыл календарь (персонально)' })
  async getShares(@CurrentUser() user: JwtPayload) {
    const data = await this.calendarService.listShares(user.sub);
    return { success: true, data };
  }

  @Post('shares')
  @ApiOperation({ summary: 'Открыть календарь человеку (busy | detailed)' })
  async setShare(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = setCalendarShareSchema.parse(body);
    await this.calendarService.setShare(user.sub, data.sharedWithUserId, data.accessLevel);
    return { success: true };
  }

  @Delete('shares/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Закрыть календарь от человека' })
  async removeShare(@CurrentUser() user: JwtPayload, @Param('userId') userId: string) {
    await this.calendarService.removeShare(user.sub, userId);
    return { success: true };
  }
}
