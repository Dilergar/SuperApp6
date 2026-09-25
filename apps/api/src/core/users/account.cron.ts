import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UsersService } from './users.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Обслуживание аккаунтов. Стирание аккаунта по истечении грейса — не здесь: его исполняет
 * оркестратор стирания core/lifecycle (джоб в срок, этапы, заморозки, сертификат).
 * Guarded by a Redis lock so it runs on a single instance when scaled.
 */
@Injectable()
export class AccountCron {
  private readonly logger = new Logger(AccountCron.name);

  constructor(
    private users: UsersService,
    private redis: RedisService,
  ) {}

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
