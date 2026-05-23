import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UsersService, ACCOUNT_GRACE_DAYS } from './users.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Permanently anonymizes accounts whose deletion grace window has elapsed.
 * Guarded by a Redis lock so it runs on a single instance when scaled.
 */
@Injectable()
export class AccountCron {
  private readonly logger = new Logger(AccountCron.name);

  constructor(
    private users: UsersService,
    private redis: RedisService,
  ) {}

  @Cron('15 3 * * *') // Daily at 03:15
  async handleExpiredDeletions() {
    const ran = await this.redis.withLock(
      'cron:account-anonymize',
      10 * 60 * 1000,
      async () => {
        const ids = await this.users.findExpiredDeletions(ACCOUNT_GRACE_DAYS);
        for (const id of ids) {
          await this.users.anonymizeAccount(id);
        }
        if (ids.length > 0) {
          this.logger.log(`Anonymized ${ids.length} expired account(s)`);
        }
      },
    );
    if (ran === null) {
      this.logger.debug('Skipped — another instance holds the anonymize lock');
    }
  }
}
