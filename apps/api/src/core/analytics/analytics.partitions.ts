import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../shared/redis/redis.service';
import { LifecyclePartitions, type LifecycleParentPartitions, type LifecyclePartitionLeaf } from '../lifecycle/lifecycle.partitions';
import { ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';

const PARENT = 'analytics.events';

/**
 * Партиции сырья `analytics.events` (месяц, UTC-границы) — через единую дверь
 * `LifecyclePartitions` (core/lifecycle): DDL исполняет функция владельца данных, пол срока
 * и заморозки проверяет база. Здесь — только своё у аналитики: срок из окружения
 * (`ANALYTICS_RETENTION_DAYS`) и сброс кэша «сбор начался …» вместе с самой старой партицией.
 */
@Injectable()
export class AnalyticsPartitions implements OnModuleInit {
  private readonly parent: LifecycleParentPartitions;

  constructor(
    private readonly lifecycle: LifecyclePartitions,
    private readonly redis: RedisService,
  ) {
    this.parent = lifecycle.forParent(PARENT);
  }

  onModuleInit(): void {
    this.lifecycle.register(PARENT, {
      retentionMs: () => analyticsEnv().retentionDays * 86_400_000,
      // «Сбор начался …» кэшируется без TTL: вместе с самой старой партицией ушло и первое
      // событие — иначе пустое состояние ссылалось бы на дату, которой нет
      onDropped: async () => {
        await this.redis.getClient().del(ANALYTICS_REDIS.firstEvent).catch(() => undefined);
      },
    });
  }

  /** Партиция месяца момента `at` (идемпотентно). */
  async ensureFor(at: Date): Promise<void> {
    await this.parent.ensureFor(at);
  }

  /** Текущий месяц и два следующих. */
  async ensureAhead(): Promise<void> {
    await this.parent.ensureAhead();
  }

  list(): Promise<LifecyclePartitionLeaf[]> {
    return this.parent.list();
  }

  /** Сбросить партиции, чья ВЕРХНЯЯ граница старше ретенции. Возвращает имена сброшенных. */
  dropExpired(now = new Date()): Promise<string[]> {
    return this.parent.dropExpired(now);
  }
}
