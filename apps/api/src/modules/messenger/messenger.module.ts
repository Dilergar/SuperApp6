import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
import { ChatCallsListener } from './chat-calls.listener';

@Module({
  // JwtModule provides JwtService for verifying the socket-handshake token
  // (the secret is passed explicitly at verify time, read from ConfigService).
  // ContactsService (used for role tags) is available globally (ContactsModule @Global).
  imports: [JwtModule.register({})],
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
    ChatCallsListener,
  ],
  exports: [MessengerService],
})
export class MessengerModule {}
