import { Injectable, OnModuleInit } from '@nestjs/common';
import { LifecyclePurgeHandlerRegistry } from '../lifecycle/lifecycle.purge.registry';
import { IdempotencyInboxService } from './idempotency.inbox.service';
import { IdempotencyMetrics } from './idempotency.metrics';
import { IdempotencyStore } from './idempotency.store';

/**
 * Шаги раннера сроков core/lifecycle для движка повторов (политики `table:idem.keys` и
 * `IdempotencyInbox` реестра): одна пачка за вызов, окно, здоровье БД и журнал прогона —
 * у раннера. Идут в ЛЮБОМ режиме движка: стоп-кран выключает защиту, а не срок хранения
 * (ящик входящих пишут вебхуки всегда — без уборки он рос бы без предела).
 */
@Injectable()
export class IdempotencyLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly store: IdempotencyStore,
    private readonly inbox: IdempotencyInboxService,
    private readonly metrics: IdempotencyMetrics,
  ) {}

  onModuleInit(): void {
    this.handlers.register('idempotency.keys', {
      purgeBatch: async ({ limit }) => {
        const n = await this.store.sweepBatch(limit);
        this.metrics.sweptRows(n);
        return { rows: n, more: n >= limit };
      },
      estimate: () => this.store.countExpired(),
    });
    this.handlers.register('idempotency.inbox', {
      purgeBatch: async ({ cutoff, limit }) => {
        if (!cutoff) return { rows: 0, more: false };
        const n = await this.inbox.pruneBatch(cutoff, limit);
        return { rows: n, more: n >= limit };
      },
      estimate: ({ cutoff }) => (cutoff ? this.inbox.countBefore(cutoff) : Promise.resolve(0)),
    });
  }
}
