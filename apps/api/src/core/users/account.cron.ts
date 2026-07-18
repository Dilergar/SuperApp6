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

  // Протухшие refresh-сессии: их не удалял никто (@@index([expiresAt]) лежал без
  // потребителя) — строки копились по числу логинов навсегда.
  @Cron('25 3 * * *')
  async handleExpiredSessions() {
    const ran = await this.redis.withLock('cron:sessions-purge', 10 * 60 * 1000, async () => {
      const n = await this.users.purgeExpiredSessions();
      if (n > 0) this.logger.log(`Purged ${n} expired session(s)`);
    });
    if (ran === null) {
      this.logger.debug('Skipped — another instance holds the sessions-purge lock');
    }
  }
}
