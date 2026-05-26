import { Module } from '@nestjs/common';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleCalendarController } from './google-calendar.controller';
import { GoogleEventsListener } from './google.events';
import { GoogleCalendarCron } from './google-calendar.cron';

@Module({
  controllers: [GoogleCalendarController],
  providers: [GoogleCalendarService, GoogleEventsListener, GoogleCalendarCron],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
