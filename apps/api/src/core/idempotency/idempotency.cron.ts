import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IDEMPOTENCY_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { idempotencyEnv } from './idempotency.constants';
import { IdempotencyInboxService } from './idempotency.inbox.service';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyPartitions } from './idempotency.partitions';
import { IdempotencyStore } from './idempotency.store';

/**
 * Фон движка (лок Redis — исполняет один инстанс флота):
 *  - каждые 10 минут: партиции снимков вперёд + показания счётчика строк;
 *  - ночью: чистка просроченных ключей батчами, сброс старых партиций снимков
 *    (`DETACH CONCURRENTLY` + `DROP`), ретенция «входящего ящика».
 *
 * Отдельного джоба у движка нет намеренно: работа чисто уборочная, ничего не
 * обязана «случиться», и ставить её в outbox значило бы гонять фон ради фона.
 */
@Injectable()
export class IdempotencyCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly store: IdempotencyStore,
    private readonly partitions: IdempotencyPartitions,
    private readonly inbox: IdempotencyInboxService,
    private readonly metrics: IdempotencyMetrics,
  ) {}

  /** Партиции вперёд на старте: пропущенный крон не должен оставить день без партиции. */
  onApplicationBootstrap(): void {
    if (idempotencyEnv().mode === 'off') return;
    void this.redis
      .withLock('cron:idempotency-partitions', 60_000, () => this.partitions.ensureAhead())
      .catch((err: unknown) =>
        this.logger.error(`idempotency partitions on boot: ${err instanceof Error ? err.message : String(err)}`),
      );
  }

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    if (idempotencyEnv().mode === 'off') return;
    await this.redis.withLock('cron:idempotency-tick', 5 * 60_000, async () => {
      await this.partitions.ensureAhead();
      this.metrics.setRows(await this.store.count());
      return true;
    });
  }

  @Cron('25 3 * * *')
  async nightly(): Promise<void> {
    if (idempotencyEnv().mode === 'off') return;
    await this.redis.withLock('cron:idempotency-nightly', 30 * 60_000, async () => {
      const swept = await this.store.sweep(IDEMPOTENCY_LIMITS.sweepBatch);
      this.metrics.sweptRows(swept);
      const dropped = await this.partitions.dropExpired();
      const inbox = await this.inbox.prune();
      this.logger.log(
        `idempotency nightly: ${swept} expired key(s) removed, ${dropped.length} snapshot partition(s) dropped, ${inbox} inbox row(s) pruned`,
      );
      return true;
    });
  }
}
