import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { CalendarCron } from './calendar.cron';
import { ResourcesService } from './resources.service';
import { ResourcesController } from './resources.controller';
import { CalendarRichCardsProvider } from './calendar-rich-cards.provider';
import { TasksModule } from '../tasks/tasks.module';
import { FinancesModule } from '../finances/finances.module';

@Module({
  // FinancesModule — виртуальный слой «Платежи» (getPaymentsForCalendar), цикла нет:
  // Финансы от календаря не зависят.
  imports: [TasksModule, FinancesModule],
  controllers: [CalendarController, ResourcesController],
  providers: [
    CalendarService,
    // String-token alias so the messenger PresenceService can resolve CalendarService
    // lazily (ModuleRef.get('CalendarService', { strict: false })) for contextual
    // presence WITHOUT importing CalendarModule — that import would create the cycle
    // MessengerModule→CalendarModule→TasksModule→MessengerModule.
    { provide: 'CalendarService', useExisting: CalendarService },
    CalendarCron,
    ResourcesService,
    CalendarRichCardsProvider,
  ],
  exports: [CalendarService],
})
export class CalendarModule {}
