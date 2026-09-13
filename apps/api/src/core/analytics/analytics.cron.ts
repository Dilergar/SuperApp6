import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { ANALYTICS_JOBS, ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';
import { addDays, dayInZone } from './analytics.enrich';
import { AnalyticsPartitions } from './analytics.partitions';

/** Карантин живёт столько дней с последнего срабатывания */
const QUARANTINE_TTL_DAYS = 30;
/** Ночной пересчёт: столько последних дней (второй ремень к «грязным» дням) */
const NIGHTLY_REBUILD_DAYS = 7;
const RETENTION_BATCH = 5000;

/**
 * Кроны движка (лок Redis — исполняет один инстанс; `null` от withLock = лок занят, не результат):
 *  - каждые 10 минут — роллапы «сегодня» и «грязных» дней (куда легли новые события);
 *  - ночью — партиции вперёд, сброс партиций старше ретенции, ретенция `rollup_actor_day`,
 *    уборка карантина, пересчёт последних 7 дней.
 */
@Injectable()
export class AnalyticsCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly partitions: AnalyticsPartitions,
  ) {}

  /** Партиции вперёд на старте: пропущенный ночной крон не должен оставить месяц без партиции. */
  onApplicationBootstrap(): void {
    void this.redis
      .withLock('cron:analytics-partitions', 60_000, () => this.partitions.ensureAhead())
      .catch((err: unknown) => this.logger.error(`analytics partitions on boot: ${err instanceof Error ? err.message : String(err)}`));
  }

  @Cron('*/10 * * * *')
  async rollupTick(): Promise<void> {
    if (!analyticsEnv().enabled) return;
    await this.redis.withLock('cron:analytics-rollup-tick', 5 * 60_000, async () => {
      const tz = analyticsEnv().timezone;
      const today = dayInZone(new Date(), tz);
      const client = this.redis.getClient();
      const dirty = await client.spop(ANALYTICS_REDIS.dirtyDays, 1000);
      const days = new Set<string>([today, ...(dirty ?? [])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
      const busy: string[] = [];
      for (const day of days) {
        const { inserted } = await this.enqueueRollup(day);
        // Пересчёт этого дня уже бежит и мог прочитать сырьё ДО новых событий — вернуть в набор
        if (!inserted && day !== today) busy.push(day);
      }
      if (busy.length) await client.sadd(ANALYTICS_REDIS.dirtyDays, ...busy);
      return days.size;
    });
  }

  @Cron('10 2 * * *')
  async nightly(): Promise<void> {
    await this.redis.withLock('cron:analytics-nightly', 30 * 60_000, async () => {
      await this.partitions.ensureAhead();
      const dropped = await this.partitions.dropExpired();
      const actorRows = await this.pruneActorDays();
      const quarantine = await this.db.analyticsQuarantine.deleteMany({
        where: { lastSeenAt: { lt: new Date(Date.now() - QUARANTINE_TTL_DAYS * 86_400_000) } },
      });
      const today = dayInZone(new Date(), analyticsEnv().timezone);
      for (let i = 1; i <= NIGHTLY_REBUILD_DAYS; i++) await this.enqueueRollup(addDays(today, -i));
      this.logger.log(
        `analytics nightly: partitions dropped ${dropped.length}, actor-day rows pruned ${actorRows}, quarantine rows removed ${quarantine.count}`,
      );
    });
  }

  enqueueRollup(day: string): Promise<{ inserted: boolean }> {
    return this.jobs.enqueue(null, { type: ANALYTICS_JOBS.rollupDay, payload: { day }, uniqueKey: `rollup:${day}` });
  }

  /** Роллап «субъект × день» живёт столько же, сколько сырьё (это данные по человеку). */
  private async pruneActorDays(): Promise<number> {
    const cutoff = addDays(dayInZone(new Date(), analyticsEnv().timezone), -analyticsEnv().retentionDays);
    let total = 0;
    for (;;) {
      const n = await this.db.$executeRaw`
        DELETE FROM analytics_rollup_actor_day
        WHERE id IN (SELECT id FROM analytics_rollup_actor_day WHERE day < ${cutoff}::date LIMIT ${RETENTION_BATCH})`;
      total += n;
      if (n < RETENTION_BATCH) return total;
    }
  }
}
