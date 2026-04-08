import { Global, Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { ContactsCron } from './contacts.cron';

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
  providers: [ContactsService, ContactsCron],
  exports: [ContactsService],
})
export class ContactsModule {}
