import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContactsService } from './contacts.service';
import { RedisService } from '../../shared/redis/redis.service';

@Injectable()
export class ContactsCron {
  private readonly logger = new Logger(ContactsCron.name);

  constructor(
    private contacts: ContactsService,
    private redis: RedisService,
  ) {}

  @Cron('0 * * * *') // Every hour
  async handleCleanup() {
    // Lock so only ONE instance runs the cleanup per tick.
    const ran = await this.redis.withLock(
      'cron:contacts-cleanup',
      10 * 60 * 1000,
      async () => {
        this.logger.log('Cleaning up expired/processed invitations...');
        await this.contacts.cleanupInvitations();
        this.logger.log('Invitation cleanup done');
      },
    );
    if (ran === null) {
      this.logger.debug('Skipped — another instance holds the cleanup lock');
    }
  }
}
