import {
  Controller, Get, Post, Delete,
  Body, Query, Headers, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GoogleCalendarService } from './google-calendar.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { selectGoogleCalendarSchema } from '@superapp/shared';

@ApiTags('Google Calendar')
@ApiBearerAuth()
@Controller('integrations/google')
export class GoogleCalendarController {
  constructor(private google: GoogleCalendarService) {}

  @Get('status')
  @ApiOperation({ summary: 'Google connection status' })
  async status(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.google.getStatus(user.sub) };
  }

  @Get('auth-url')
  @ApiOperation({ summary: 'The link that connects Google (OAuth)' })
  authUrl(@CurrentUser() user: JwtPayload) {
    return { success: true, data: { url: this.google.getAuthUrl(user.sub) } };
  }

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback (Google → redirect to the web app)' })
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    try {
      const redirect = await this.google.handleCallback(code, state);
      res.redirect(redirect);
    } catch {
      res.redirect(`${webUrl}/calendar?google=error`);
    }
  }

  @Get('calendars')
  @ApiOperation({ summary: 'My Google calendars' })
  async calendars(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.google.listCalendars(user.sub) };
  }

  @Post('select-calendar')
  @ApiOperation({ summary: 'Pick the calendar to sync with (__new__ = create a SuperApp6 one)' })
  async select(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = selectGoogleCalendarSchema.parse(body);
    await this.google.selectCalendar(user.sub, data.calendarId);
    return { success: true };
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync now' })
  async sync(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.google.syncNow(user.sub) };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect Google' })
  async disconnect(@CurrentUser() user: JwtPayload) {
    await this.google.disconnect(user.sub);
    return { success: true };
  }

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receiver for Google push notifications' })
  async webhook(
    @Headers('x-goog-channel-id') channelId: string,
    @Headers('x-goog-resource-state') resourceState: string,
  ) {
    if (channelId) await this.google.handleWebhook(channelId, resourceState || '');
    return { success: true };
  }
}
