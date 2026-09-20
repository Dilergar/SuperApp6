import {
  Controller, Get, Post, Delete,
  Body, Query, Headers, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GoogleCalendarService } from './google-calendar.service';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
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
  async authUrl(@CurrentUser() user: JwtPayload) {
    return { success: true, data: { url: await this.google.getAuthUrl(user.sub) } };
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

  // Ручная синхронизация: инкрементальна по `syncToken` Google — повтор не создаёт второго
  @SkipIdempotency('naturally_idempotent')
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
  // Входящее уведомление чужой системы: аутентификация — токен канала (см. сервис),
  // дедуп не нужен — инкрементальная синхронизация естественно идемпотентна
  @SkipIdempotency('inbound_webhook')
  @ApiOperation({ summary: 'Receiver for Google push notifications' })
  async webhook(
    @Headers('x-goog-channel-id') channelId: string,
    @Headers('x-goog-resource-state') resourceState: string,
    @Headers('x-goog-channel-token') channelToken?: string,
  ) {
    if (channelId) await this.google.handleWebhook(channelId, resourceState || '', channelToken);
    return { success: true };
  }
}
