import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { CalendarEventsListener } from './calendar.events';

@Module({
  controllers: [CalendarController],
  providers: [CalendarService, CalendarEventsListener],
  exports: [CalendarService],
})
export class CalendarModule {}
