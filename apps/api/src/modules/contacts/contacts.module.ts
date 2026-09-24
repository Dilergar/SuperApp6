import { Global, Module } from '@nestjs/common';
import { ContactsAudiencesProvider } from './contacts-audiences.provider';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { ContactsCron } from './contacts.cron';
import { PersonalGraphRegistry } from './personal-graph.registry';
import { ContactsNotificationRefsProvider } from './contacts-notification-refs.provider';
import { ContactsVisibilityProvider } from './contacts-visibility.provider';

/**
 * ContactsModule — bilateral confirmed social graph.
 *
 * Marked @Global() so AuthService can inject ContactsService to call
 * `activatePendingInvitationsForNewUser` on registration without pulling
 * AuthModule into a circular dependency.
 */
@Global()
@Module({
  controllers: [ContactsController],
  providers: [
    // Движок уведомлений: резолвер объекта (право видеть батчем + deep link) — фича → движок
    ContactsNotificationRefsProvider,
    ContactsService,
    ContactsCron,
    PersonalGraphRegistry,
    ContactsAudiencesProvider,
    // Движок видимости: личный граф (связь, Группы, коллеги) + снятие исключений при разрыве связи
    ContactsVisibilityProvider,
  ],
  exports: [ContactsService, PersonalGraphRegistry],
})
export class ContactsModule {}
