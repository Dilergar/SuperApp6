import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { LifecyclePartitions } from './lifecycle.partitions';

/**
 * Ночное обслуживание партиций всех журналов — в окне массового ретеншна 01:00–06:00 по
 * Алматы (plan §6.1): вперёд, сброс по сроку, ANALYZE родителей, здоровье → метрики.
 * Под Redis-локом — один инстанс (`null` от withLock = лок занят, не результат).
 */
@Injectable()
export class LifecycleCron {
  private readonly logger = new Logger(LifecycleCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly partitions: LifecyclePartitions,
  ) {}

  @Cron('40 1 * * *', { timeZone: 'Asia/Almaty' })
  async partitionsNightly(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-partitions', 30 * 60_000, async () => {
      const { dropped, health } = await this.partitions.maintain();
      const total = Object.values(dropped).reduce((n, l) => n + l.length, 0);
      this.logger.log(`partitions nightly: ${health.length} parents, ${total} partition(s) dropped by retention`);
    });
    if (ran === null) this.logger.debug('partitions nightly skipped: lock held by another instance');
  }

  /** Здоровье чаще, чем раз в сутки: метрика «вперёд < 2» должна загореться до полуночи месяца. */
  @Cron('17 */6 * * *')
  async partitionsHealth(): Promise<void> {
    await this.partitions.health();
  }
}
