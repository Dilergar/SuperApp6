import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IDEMPOTENCY_LIMITS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';
import { idempotencyEnv } from './idempotency.constants';
import { IdempotencyInboxService } from './idempotency.inbox.service';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyStore } from './idempotency.store';

/**
 * Фон движка (лок Redis — исполняет один инстанс флота):
 *  - каждые 10 минут: показания счётчика строк;
 *  - ночью: чистка просроченных ключей батчами, ретенция «входящего ящика» — в ЛЮБОМ режиме.
 * Партиции снимков (вперёд на буте и ночью, сброс по сроку) обслуживает core/lifecycle.
 *
 * Отдельного джоба у движка нет намеренно: работа чисто уборочная, ничего не
 * обязана «случиться», и ставить её в outbox значило бы гонять фон ради фона.
 */
@Injectable()
export class IdempotencyCron {
  private readonly logger = new Logger(IdempotencyCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly store: IdempotencyStore,
    private readonly inbox: IdempotencyInboxService,
    private readonly metrics: IdempotencyMetrics,
  ) {}

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    if (idempotencyEnv().mode === 'off') return;
    await this.redis.withLock('cron:idempotency-tick', 5 * 60_000, async () => {
      this.metrics.setRows(await this.store.count());
      return true;
    });
  }

  /**
   * Ночная уборка идёт в ЛЮБОМ режиме, включая `off`: стоп-кран выключает защиту, а не
   * срок хранения. «Входящий ящик» режиму не подчиняется вовсе (вебхуки пишут в него
   * всегда), и без уборки он рос бы без предела ровно тогда, когда на движок никто не
   * смотрит. Шаги независимы: сбой одного не отменяет остальные.
   */
  @Cron('25 3 * * *')
  async nightly(): Promise<void> {
    await this.redis.withLock('cron:idempotency-nightly', 30 * 60_000, async () => {
      const swept = await this.step('expired keys', () => this.store.sweep(IDEMPOTENCY_LIMITS.sweepBatch));
      this.metrics.sweptRows(swept ?? 0);
      const inbox = await this.step('inbox retention', () => this.inbox.prune());
      this.logger.log(`idempotency nightly: ${swept ?? '?'} expired key(s) removed, ${inbox ?? '?'} inbox row(s) pruned`);
      return true;
    });
  }

  /** Один шаг уборки: его сбой — строка в логе, а не отмена следующих шагов. */
  private async step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      this.logger.error(`idempotency nightly — ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
