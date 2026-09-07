import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { ScheduledMessageService } from './scheduled-message.service';

/**
 * Ночная гигиена мессенджера: закрытые отложенные строки (упоминания живут в движке
 * уведомлений и чистятся его ретеншном).
 * Выстрел отложенных сообщений — больше НЕ здесь: джоб core/jobs с runAt=sendAt
 * (ставится в транзакции планирования, поминутный поллер fireDue умер).
 */
@Injectable()
export class ScheduledMessageCron {
  private readonly logger = new Logger(ScheduledMessageCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly scheduled: ScheduledMessageService,
  ) {}

  @Cron('35 3 * * *')
  async nightlyCleanup(): Promise<void> {
    const ran = await this.redis.withLock('cron:messenger-cleanup', 10 * 60 * 1000, async () => {
      const scheduled = await this.scheduled.purgeOld();
      if (scheduled) this.logger.log(`messenger cleanup: scheduled=${scheduled}`);
    });
    if (ran === null) this.logger.debug('Skipped messenger cleanup — lock held elsewhere');
  }
}
