import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../shared/redis/redis.service';
import { AUDIT_REDIS } from './audit.constants';
import { AuditService } from './audit.service';

export interface AuditViewedDelta {
  queries?: number;
  rows?: number;
  reveals?: number;
}

/** Час-корзина UTC: `2026092314` */
const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');

/**
 * Мета-аудит журнала (NIST AU-9): кто из сотрудников платформы смотрел журнал безопасности.
 * Построчная запись каждого просмотра раздувала бы журнал сильнее самих событий — поэтому
 * агрегат на (сотрудник, час): счётчики в Redis, раз в час — одно событие `audit.viewed`
 * {queries, rows, reveals}. Redis недоступен → событие пишется сразу этой же дельтой:
 * мета-аудит не теряется из-за кэша. Раскрытие IP дополнительно пишет свой
 * `platform.access.reveal` построчно (раскрытие ПДн — всегда отдельный факт).
 */
@Injectable()
export class AuditViewedService {
  private readonly logger = new Logger(AuditViewedService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async bump(actorId: string, delta: AuditViewedDelta): Promise<void> {
    const hour = hourOf(Date.now());
    const key = AUDIT_REDIS.viewed(actorId, hour);
    try {
      const pipe = this.redis.getClient().pipeline();
      if (delta.queries) pipe.hincrby(key, 'queries', delta.queries);
      if (delta.rows) pipe.hincrby(key, 'rows', delta.rows);
      if (delta.reveals) pipe.hincrby(key, 'reveals', delta.reveals);
      pipe.expire(key, 3 * 86_400);
      pipe.sadd(AUDIT_REDIS.viewedIndex, `${actorId}|${hour}`);
      await pipe.exec();
    } catch (err) {
      this.logger.warn(`viewed counter is unavailable, recording directly: ${(err as Error).message}`);
      await this.audit.recordBestEffort({
        key: 'audit.viewed',
        actor: { kind: 'platform_staff', id: actorId },
        details: { queries: delta.queries ?? 0, rows: delta.rows ?? 0, reveals: delta.reveals ?? 0 },
        ctx: { client: 'console' },
        evenInPreview: true,
      });
    }
  }

  /**
   * Сбросить завершённые часы в журнал. `recordOnce` по (сотрудник, час) — повторный прогон
   * (два инстанса, падение между записью и удалением счётчика) второго события не даёт.
   */
  async flush(now = Date.now()): Promise<number> {
    const current = hourOf(now);
    const client = this.redis.getClient();
    const members = await client.smembers(AUDIT_REDIS.viewedIndex);
    let written = 0;
    for (const m of members) {
      const [actorId, hour] = m.split('|');
      if (!actorId || !hour || hour >= current) continue;
      const key = AUDIT_REDIS.viewed(actorId, hour);
      const h = await client.hgetall(key);
      const n = (v: string | undefined) => Math.max(0, Math.min(Number.parseInt(v ?? '0', 10) || 0, 2_000_000_000));
      if (Object.keys(h).length) {
        const r = await this.audit.recordOnce(
          null,
          `viewed:${actorId}:${hour}`,
          {
            key: 'audit.viewed',
            actor: { kind: 'platform_staff', id: actorId },
            details: { queries: n(h.queries), rows: n(h.rows), reveals: n(h.reveals) },
            ctx: { client: 'console' },
          },
          7 * 86_400,
        );
        if (r) written++;
      }
      await client.multi().del(key).srem(AUDIT_REDIS.viewedIndex, m).exec();
    }
    return written;
  }
}
