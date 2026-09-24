import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { NotificationsSettingsService } from './notifications.settings.service';

/**
 * Устройства без визита 60 дней отключаются (окно свежести FCM) — смена состояния, а не
 * удаление. Сроки хранения (строки ленты, события, устройства, журнал доставки) ведёт
 * раннер core/lifecycle по реестру (`notifications.lifecycle.provider.ts`).
 */
@Injectable()
export class NotificationsCron {
  private readonly logger = new Logger(NotificationsCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly settings: NotificationsSettingsService,
  ) {}

  @Cron('30 3 * * *')
  async staleDevices(): Promise<void> {
    const ran = await this.redis.withLock('cron:notifications-devices', 10 * 60 * 1000, async () => {
      const devices = await this.settings.expireStaleDevices();
      if (devices) this.logger.log(`stale devices disabled: ${devices}`);
    });
    if (ran === null) this.logger.debug('stale devices skipped: lock held by another instance');
  }
}
