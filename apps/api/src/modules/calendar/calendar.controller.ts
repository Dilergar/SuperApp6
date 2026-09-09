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
  @ApiOperation({ summary: 'The calendar for a period: events + the tasks layer + other people’s overlays' })
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
  @ApiOperation({ summary: 'People whose calendars are available to me (for the overlays)' })
  async sharedWithMe(@CurrentUser() user: JwtPayload) {
    const data = await this.calendarService.listSharedWithMe(user.sub);
    return { success: true, data };
  }

  @Post('smart-match')
  @ApiOperation({ summary: 'Find a free slot for everyone (Smart Match)' })
  async smartMatch(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = smartMatchSchema.parse(body);
    const result = await this.calendarService.smartMatch(user.sub, data);
    return { success: true, data: result };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Event details (with the participants)' })
  async getEvent(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.calendarService.getEventDetail(user.sub, id);
    return { success: true, data };
  }

  @Post('events')
  @ApiOperation({ summary: 'Create an event (with participants)' })
  async createEvent(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createCalendarEventSchema.parse(body);
    const event = await this.calendarService.createEvent(user.sub, data);
    return { success: true, data: event };
  }

  @Patch('events/:id')
  @ApiOperation({ summary: 'Update an event (editScope: this | this_and_following | all)' })
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
  @ApiOperation({ summary: 'Delete an event or a single occurrence of a series' })
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
  @ApiOperation({ summary: 'Invite participants (a person or a Group from the Circle)' })
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
  @ApiOperation({ summary: 'Remove a participant (organizer) or leave (yourself)' })
  async removeParticipant(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.calendarService.removeParticipant(user.sub, id, userId);
    return { success: true };
  }

  @Post('events/:id/rsvp')
  @ApiOperation({ summary: 'Answer an invitation (accepted | declined | tentative)' })
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
  @ApiOperation({ summary: 'My reminders for an event' })
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
  @ApiOperation({ summary: 'Who I opened my calendar to (personally)' })
  async getShares(@CurrentUser() user: JwtPayload) {
    const data = await this.calendarService.listShares(user.sub);
    return { success: true, data };
  }

  @Post('shares')
  @ApiOperation({ summary: 'Open the calendar to a person (busy | detailed)' })
  async setShare(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = setCalendarShareSchema.parse(body);
    await this.calendarService.setShare(user.sub, data.sharedWithUserId, data.accessLevel);
    return { success: true };
  }

  @Delete('shares/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a person’s calendar access' })
  async removeShare(@CurrentUser() user: JwtPayload, @Param('userId') userId: string) {
    await this.calendarService.removeShare(user.sub, userId);
    return { success: true };
  }
}
