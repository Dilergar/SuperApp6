import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NOTIFICATION_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { NotificationsSettingsService } from './notifications.settings.service';

/**
 * Ретеншн: строки ленты 90 дней (Saved — вечно, отложенные в будущее не трогаем),
 * события — когда не осталось строк адресатов, журнал доставки — 30 дней, устройства
 * без визита 60 дней — отключаются. Батчами по индексу createdAt, под Redis-локом.
 */
@Injectable()
export class NotificationsCron {
  private readonly logger = new Logger(NotificationsCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly settings: NotificationsSettingsService,
  ) {}

  @Cron('30 3 * * *')
  async retention(): Promise<void> {
    const ran = await this.redis.withLock('cron:notifications-retention', 20 * 60 * 1000, async () => {
      const rows = await this.pruneRows();
      const events = await this.pruneEvents();
      const deliveries = await this.pruneDeliveries();
      const devices = await this.settings.expireStaleDevices();
      this.logger.log(`retention: rows ${rows}, events ${events}, deliveries ${deliveries}, devices disabled ${devices}`);
    });
    if (ran === null) this.logger.debug('retention skipped: lock held by another instance');
  }

  async pruneRows(): Promise<number> {
    const cutoff = new Date(Date.now() - NOTIFICATION_LIMITS.retentionDays * 86_400_000);
    const now = new Date();
    const BATCH = 10_000;
    let total = 0;
    for (;;) {
      const rows = await this.db.notification.findMany({
        where: { createdAt: { lt: cutoff }, savedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const res = await this.db.notification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += res.count;
      if (rows.length < BATCH) break;
    }
    return total;
  }

  /** Событие без строк адресатов и без свежих доставок — мусор. */
  async pruneEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - NOTIFICATION_LIMITS.deliveryRetentionDays * 86_400_000);
    const BATCH = 5_000;
    let total = 0;
    for (;;) {
      const events = await this.db.notificationEvent.findMany({
        where: { createdAt: { lt: cutoff }, notifications: { none: {} } },
        select: { id: true },
        take: BATCH,
      });
      if (!events.length) break;
      const res = await this.db.notificationEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
      total += res.count;
      if (events.length < BATCH) break;
    }
    return total;
  }

  async pruneDeliveries(): Promise<number> {
    const cutoff = new Date(Date.now() - NOTIFICATION_LIMITS.deliveryRetentionDays * 86_400_000);
    const BATCH = 10_000;
    let total = 0;
    for (;;) {
      const rows = await this.db.notificationDelivery.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: BATCH });
      if (!rows.length) break;
      const res = await this.db.notificationDelivery.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += res.count;
      if (rows.length < BATCH) break;
    }
    return total;
  }
}
