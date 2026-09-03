import { Global, Module } from '@nestjs/common';
import { ContactsAudiencesProvider } from './contacts-audiences.provider';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { ContactsCron } from './contacts.cron';
import { PersonalGraphRegistry } from './personal-graph.registry';

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
  providers: [ContactsService, ContactsCron, PersonalGraphRegistry, ContactsAudiencesProvider],
  exports: [ContactsService, PersonalGraphRegistry],
})
export class ContactsModule {}
