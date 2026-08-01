import { Module } from '@nestjs/common';
import { MessengerController } from './messenger.controller';
import { MentionsController } from './mentions.controller';
import { MessengerService } from './messenger.service';
import { MentionsService } from './mentions.service';
import { MessengerSearchService } from './messenger-search.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { ScheduledMessageCron } from './scheduled-message.cron';
import { PresenceService } from './presence.service';
import { MessengerGateway } from './messenger.gateway';
import { ChatterChatSink } from './chatter-chat.sink';
import { OrderSystemListener } from './order-system.listener';
import { CalendarSystemListener } from './calendar-system.listener';
import { OfficeSystemListener } from './office-system.listener';
import { DocsSystemListener } from './docs-system.listener';
import { ChatCallsListener } from './chat-calls.listener';
import { DriveModule } from '../drive/drive.module';

@Module({
  // Токен рукопожатия сокета проверяет SessionValidatorService (@Global,
  // shared/auth) — он же держит проверку отзыва сессии, общую с HTTP-путём.
  // ContactsService (used for role tags) is available globally (ContactsModule @Global).
  //
  // DriveModule импортируется РАДИ РЕЕСТРА маршрутизации: мессенджер сам объявляет,
  // куда складывать свои файлы (из DM — на личный диск, из чатов организации — на её).
  // Направление такое же, как у слоёв календаря: знание о природе сущности живёт у
  // её владельца, а движок-получатель про потребителей не знает.
  imports: [DriveModule],
  controllers: [MessengerController, MentionsController],
  providers: [
    MessengerService,
    MentionsService,
    MessengerSearchService,
    ScheduledMessageService,
    ScheduledMessageCron,
    PresenceService,
    // String-token alias so the @Global RichCardsService can resolve MessengerService
    // lazily (ModuleRef.get('MessengerService')) for shareToChat without a module cycle.
    { provide: 'MessengerService', useExisting: MessengerService },
    MessengerGateway,
    // Плашки задач = проекция хроники core/chatter (chat-sink; заменил TaskSystemListener)
    ChatterChatSink,
    OrderSystemListener,
    CalendarSystemListener,
    OfficeSystemListener,
    // Плашка «файл открыт как документ» (движок core/docs объявляет событие на шину)
    DocsSystemListener,
    ChatCallsListener,
  ],
  exports: [MessengerService],
})
export class MessengerModule {}
