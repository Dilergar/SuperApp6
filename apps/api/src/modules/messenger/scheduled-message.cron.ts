import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { MentionsService } from './mentions.service';

/**
 * Ночная гигиена мессенджера: закрытые отложенные строки и старые упоминания.
 * Выстрел отложенных сообщений — больше НЕ здесь: джоб core/jobs с runAt=sendAt
 * (ставится в транзакции планирования, поминутный поллер fireDue умер).
 */
@Injectable()
export class ScheduledMessageCron {
  private readonly logger = new Logger(ScheduledMessageCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly scheduled: ScheduledMessageService,
    private readonly mentions: MentionsService,
  ) {}

  @Cron('35 3 * * *')
  async nightlyCleanup(): Promise<void> {
    const ran = await this.redis.withLock('cron:messenger-cleanup', 10 * 60 * 1000, async () => {
      const scheduled = await this.scheduled.purgeOld();
      const mentions = await this.mentions.purgeOld();
      if (scheduled || mentions) {
        this.logger.log(`messenger cleanup: scheduled=${scheduled}, mentions=${mentions}`);
      }
    });
    if (ran === null) this.logger.debug('Skipped messenger cleanup — lock held elsewhere');
  }
}
