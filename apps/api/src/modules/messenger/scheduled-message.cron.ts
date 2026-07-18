import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { MentionsService } from './mentions.service';

/**
 * Fires due scheduled messages ("Напомнить") every minute. Single instance via Redis lock
 * (like the other crons). The work + per-row error handling lives in the service.
 * Плюс ночная гигиена мессенджера: закрытые отложенные строки и старые упоминания.
 */
@Injectable()
export class ScheduledMessageCron {
  private readonly logger = new Logger(ScheduledMessageCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly scheduled: ScheduledMessageService,
    private readonly mentions: MentionsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.redis.withLock('cron:scheduled-messages', 60 * 1000, async () => {
      const fired = await this.scheduled.fireDue();
      if (fired > 0) this.logger.log(`fired ${fired} scheduled message(s)`);
    });
  }

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
