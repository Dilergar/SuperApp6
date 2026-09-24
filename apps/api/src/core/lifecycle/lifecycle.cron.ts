import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { LifecycleLooseFk } from './lifecycle.loose-fk';
import { LifecyclePartitions } from './lifecycle.partitions';
import { LifecyclePurgeRunner } from './lifecycle.purge';

/**
 * Ночное обслуживание движка — в окне массового ретеншна 01:00–06:00 по Алматы (plan §6.1):
 * план прогонов сроков (джоб на политику), партиции журналов (вперёд, сброс по сроку,
 * ANALYZE родителей), здоровье → метрики. Loose FK — круглосуточно каждые 5 минут (удаление
 * родителя не ждёт ночи, хвосты детей — тоже).
 * Под Redis-локом — один инстанс (`null` от withLock = лок занят, не результат).
 */
@Injectable()
export class LifecycleCron {
  private readonly logger = new Logger(LifecycleCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly partitions: LifecyclePartitions,
    private readonly purge: LifecyclePurgeRunner,
    private readonly looseFk: LifecycleLooseFk,
  ) {}

  /** План ночи: прогон каждой ведомой политики (джоб ждёт окна сам, живой дубль не ставится). */
  @Cron('10 1 * * *', { timeZone: 'Asia/Almaty' })
  async purgeNightly(): Promise<void> {
    const ran = await this.redis.withLock('cron:lifecycle-purge-plan', 10 * 60_000, async () => {
      const queued = await this.purge.planNightly();
      this.logger.log(`retention plan: ${queued} purge run(s) queued`);
    });
    if (ran === null) this.logger.debug('retention plan skipped: lock held by another instance');
  }

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

  /** Loose FK: проход по учёту удалений (один живой джоб на кластер — uniqueKey) + метрика хвоста. */
  @Cron('*/5 * * * *')
  async looseFkTick(): Promise<void> {
    try {
      if ((await this.looseFk.backlog()) > 0) await this.looseFk.schedule();
    } catch (err) {
      this.logger.warn(`loose FK tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
