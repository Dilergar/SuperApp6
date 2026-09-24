import { Injectable, OnModuleInit } from '@nestjs/common';
import { LifecyclePartitions, type LifecycleParentPartitions, type LifecyclePartitionLeaf } from '../lifecycle/lifecycle.partitions';
import { idempotencyEnv } from './idempotency.constants';

const PARENT = 'idem.responses';

/**
 * Партиции снимков `idem.responses` (день, границы UTC) — через единую дверь
 * `LifecyclePartitions` (core/lifecycle): снимок живёт часы, поэтому ретенция — сброс
 * партиции целиком функцией владельца, а не DELETE миллионов строк. Своё у движка — срок
 * из окружения (`IDEMPOTENCY_RESPONSE_TTL_HOURS`).
 *
 * НЕТ партиции = «тела нет»: вставка снимка молча пропускается, запрос НЕ падает.
 * Идемпотентность защищает эффект, а не возможность показать тело второй раз.
 */
@Injectable()
export class IdempotencyPartitions implements OnModuleInit {
  private readonly parent: LifecycleParentPartitions;

  constructor(private readonly lifecycle: LifecyclePartitions) {
    this.parent = lifecycle.forParent(PARENT);
  }

  onModuleInit(): void {
    this.lifecycle.register(PARENT, { retentionMs: () => idempotencyEnv().responseTtlHours * 3_600_000 });
  }

  /** Партиция дня момента `at` (идемпотентно). */
  async ensureFor(at: Date): Promise<void> {
    await this.parent.ensureFor(at);
  }

  /** Сегодня и два следующих дня. */
  async ensureAhead(): Promise<void> {
    await this.parent.ensureAhead();
  }

  list(): Promise<LifecyclePartitionLeaf[]> {
    return this.parent.list();
  }

  /** Сбросить партиции, чья ВЕРХНЯЯ граница старше окна снимка. Возвращает имена. */
  dropExpired(now = new Date()): Promise<string[]> {
    return this.parent.dropExpired(now);
  }
}
