import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';

const PARTITION_RE = /^events_(\d{4})_(\d{2})$/;

/** Имя месячной партиции из валидированных чисел — единственное, что уходит в DDL. */
const partitionName = (year: number, month: number) => `events_${year}_${String(month).padStart(2, '0')}`;

/**
 * Партиции сырья `analytics.events` (месяц, UTC-границы). DDL собирается ТОЛЬКО из
 * чисел года и месяца — `$executeRawUnsafe` не видит пользовательского ввода.
 * Удаление по ретенции — `DETACH … CONCURRENTLY` + `DROP`: сброс месяца целиком
 * вместо DELETE миллионов строк.
 */
@Injectable()
export class AnalyticsPartitions {
  private readonly logger = new Logger(AnalyticsPartitions.name);
  /** Партиции, уже подтверждённые этим инстансом */
  private readonly known = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Партиция месяца момента `at` (идемпотентно). */
  async ensureFor(at: Date): Promise<void> {
    const year = at.getUTCFullYear();
    const month = at.getUTCMonth() + 1;
    const name = partitionName(year, month);
    if (this.known.has(name)) return;
    const lo = `${year}-${String(month).padStart(2, '0')}-01 00:00:00+00`;
    const next = new Date(Date.UTC(year, month, 1));
    const hi = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00+00`;
    await this.db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS analytics.${name} PARTITION OF analytics.events FOR VALUES FROM ('${lo}') TO ('${hi}')`,
    );
    // Таблица только растёт вставками: автовакуум по объёму вставок, а не по 20 % строк
    await this.db.$executeRawUnsafe(
      `ALTER TABLE analytics.${name} SET (autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)`,
    );
    this.known.add(name);
  }

  /** Текущий месяц и два следующих. */
  async ensureAhead(): Promise<void> {
    const now = new Date();
    for (let i = 0; i < 3; i++) await this.ensureFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)));
  }

  async list(): Promise<Array<{ name: string; from: Date; to: Date }>> {
    const rows = await this.db.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'analytics' AND p.relname = 'events'
      ORDER BY c.relname`;
    const out: Array<{ name: string; from: Date; to: Date }> = [];
    for (const r of rows) {
      const m = PARTITION_RE.exec(r.name);
      if (!m) continue;
      const year = Number(m[1]);
      const month = Number(m[2]);
      out.push({ name: partitionName(year, month), from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) });
    }
    return out;
  }

  /** Сбросить партиции, чья ВЕРХНЯЯ граница старше ретенции. Возвращает имена сброшенных. */
  async dropExpired(now = new Date()): Promise<string[]> {
    const cutoff = now.getTime() - analyticsEnv().retentionDays * 86_400_000;
    const dropped: string[] = [];
    for (const p of await this.list()) {
      if (p.to.getTime() > cutoff) continue;
      // CONCURRENTLY не держит эксклюзивный лок на родителе (вставки идут дальше);
      // вне транзакции — Prisma исполняет raw вне неё
      await this.db.$executeRawUnsafe(`ALTER TABLE analytics.events DETACH PARTITION analytics.${p.name} CONCURRENTLY`);
      await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS analytics.${p.name}`);
      this.known.delete(p.name);
      dropped.push(p.name);
      this.logger.log(`analytics partition dropped by retention: ${p.name}`);
    }
    // «Сбор начался …» кэшируется без TTL: вместе с самой старой партицией ушло и
    // первое событие — иначе пустое состояние ссылалось бы на дату, которой нет
    if (dropped.length) await this.redis.getClient().del(ANALYTICS_REDIS.firstEvent).catch(() => undefined);
    return dropped;
  }
}
