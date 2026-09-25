import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { ANALYTICS_JOBS, ANALYTICS_REDIS, analyticsEnv } from './analytics.constants';
import { addDays, dayInZone } from './analytics.enrich';

/** Ночной пересчёт: столько последних дней (второй ремень к «грязным» дням) */
const NIGHTLY_REBUILD_DAYS = 7;

/**
 * Кроны движка (лок Redis — исполняет один инстанс; `null` от withLock = лок занят, не результат):
 *  - каждые 10 минут — роллапы «сегодня» и «грязных» дней (куда легли новые события);
 *  - ночью — пересчёт последних 7 дней.
 * Сроки (роллап «субъект × день» — шаг `analytics.actor-days`, карантин, склейки, партиции
 * сырья) принуждает раннер core/lifecycle — своего крона удаления по сроку здесь нет.
 */
@Injectable()
export class AnalyticsCron {
  private readonly logger = new Logger(AnalyticsCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

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
      const today = dayInZone(new Date(), analyticsEnv().timezone);
      for (let i = 1; i <= NIGHTLY_REBUILD_DAYS; i++) await this.enqueueRollup(addDays(today, -i));
      this.logger.log(`analytics nightly: last ${NIGHTLY_REBUILD_DAYS} days queued for a rebuild`);
    });
  }

  enqueueRollup(day: string): Promise<{ inserted: boolean }> {
    return this.jobs.enqueue(null, { type: ANALYTICS_JOBS.rollupDay, payload: { day }, uniqueKey: `rollup:${day}` });
  }
}
