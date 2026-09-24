import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { idempotencyEnv } from './idempotency.constants';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyStore } from './idempotency.store';

/**
 * Фон движка (лок Redis — исполняет один инстанс флота): каждые 10 минут — показания
 * счётчика строк. Чистка просроченных ключей и ретенция «входящего ящика» — шаги раннера
 * сроков core/lifecycle (`idempotency.keys` / `idempotency.inbox`, в ЛЮБОМ режиме движка:
 * стоп-кран выключает защиту, а не срок хранения); партиции снимков — тоже core/lifecycle.
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
}
