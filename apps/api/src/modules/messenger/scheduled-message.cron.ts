import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { ScheduledMessageService } from './scheduled-message.service';

/**
 * Fires due scheduled messages ("Напомнить") every minute. Single instance via Redis lock
 * (like the other crons). The work + per-row error handling lives in the service.
 */
@Injectable()
export class ScheduledMessageCron {
  private readonly logger = new Logger(ScheduledMessageCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly scheduled: ScheduledMessageService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.redis.withLock('cron:scheduled-messages', 60 * 1000, async () => {
      const fired = await this.scheduled.fireDue();
      if (fired > 0) this.logger.log(`fired ${fired} scheduled message(s)`);
    });
  }
}
