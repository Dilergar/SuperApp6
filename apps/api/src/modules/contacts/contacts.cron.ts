import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContactsService } from './contacts.service';

@Injectable()
export class ContactsCron {
  private readonly logger = new Logger(ContactsCron.name);

  constructor(private contacts: ContactsService) {}

  @Cron('0 * * * *') // Every hour
  async handleCleanup() {
    this.logger.log('Cleaning up expired/processed invitations...');
    await this.contacts.cleanupInvitations();
    this.logger.log('Invitation cleanup done');
  }
}
