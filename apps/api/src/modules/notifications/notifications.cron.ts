import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';
import { RedisService } from '../../shared/redis/redis.service';

/**
 * Retention job: prunes notifications older than the retention window so the
 * notifications table can't grow without bound. Guarded by a Redis lock so it
 * runs on a single instance when horizontally scaled.
 */
@Injectable()
export class NotificationsCron {
  private readonly logger = new Logger(NotificationsCron.name);

  constructor(
    private notifications: NotificationsService,
    private redis: RedisService,
  ) {}

  @Cron('30 3 * * *') // Daily at 03:30
  async handleRetention() {
    const ran = await this.redis.withLock(
      'cron:notifications-retention',
      10 * 60 * 1000,
      async () => {
        const deleted = await this.notifications.cleanupOld();
        this.logger.log(`Pruned ${deleted} old notifications`);
      },
    );
    if (ran === null) {
      this.logger.debug('Skipped — another instance holds the retention lock');
    }
  }
}
