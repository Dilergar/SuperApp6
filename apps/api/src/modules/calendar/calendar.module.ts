import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { CalendarCron } from './calendar.cron';
import { ResourcesService } from './resources.service';
import { ResourcesController } from './resources.controller';
import { CalendarRichCardsProvider } from './calendar-rich-cards.provider';
import { CalendarLayersRegistry } from './calendar-layers.registry';
import { CalendarNotificationRefsProvider } from './calendar-notification-refs.provider';
import { CalendarLifecycleProvider } from './calendar.lifecycle.provider';

@Module({
  // Чужих модулей календарь НЕ импортирует: слои «Задачи»/«Платежи» (и любые будущие —
  // привычки, брони…) приходят через CalendarLayersRegistry. Модуль-владелец данных сам
  // импортирует CalendarModule и регистрирует провайдер в onModuleInit (розетка платформы).
  controllers: [CalendarController, ResourcesController],
  providers: [
    CalendarLifecycleProvider,
    // Движок уведомлений: резолвер объекта (право видеть батчем + deep link) — фича → движок
    CalendarNotificationRefsProvider,
    CalendarService,
    // String-token alias so the messenger PresenceService can resolve CalendarService
    // lazily (ModuleRef.get('CalendarService', { strict: false })) for contextual
    // presence WITHOUT importing CalendarModule.
    { provide: 'CalendarService', useExisting: CalendarService },
    CalendarCron,
    ResourcesService,
    CalendarRichCardsProvider,
    CalendarLayersRegistry,
  ],
  exports: [CalendarService, CalendarLayersRegistry],
})
export class CalendarModule {}
