import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Gauge } from 'prom-client';
import { DatabaseService } from '../database/database.service';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { HealthRegistry, type HealthCheck, type HealthCheckResult } from './health.registry';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  /** Когда проверки прогонялись (ISO): параллельные и повторные пробы в пределах секунды делят один отчёт */
  at: string;
  checks: Record<string, HealthCheckResult & { ms: number; critical: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 2000;
/**
 * Отчёт готовности живёт секунду: проба публична и без троттлинга (адреса балансировщика), и
 * без памяти каждый вызов = запрос к базе и Redis — чужой цикл `curl /health/ready` стал бы
 * нагрузкой на зависимости. Параллельные вызовы делят один прогон проверок.
 */
const REPORT_TTL_MS = 1000;

/** Проверка под потолком времени: зависшая зависимость — провал, а не висящая проба балансировщика. */
async function runWithTimeout(check: HealthCheck): Promise<HealthCheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check.run(),
      new Promise<HealthCheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'fail', detail: { reason: 'timeout' } }), check.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return { status: 'fail', detail: { reason: err instanceof Error ? err.name : 'error' } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Готовность инстанса (docs/data_architecture.md): база (пул приложения — через PgBouncer в
 * проде) и Redis-состояние — критичны; Redis-кэш и проверки движков — деградация. Результат
 * каждой проверки — в метрике `health_check_status` (1 ок / 0.5 предупреждение / 0 провал).
 */
@Injectable()
export class HealthService implements OnModuleInit {
  private readonly gauge: Gauge<string>;
  private memo: { at: number; report: HealthReport } | null = null;
  private inflight: Promise<HealthReport> | null = null;

  constructor(
    private readonly registry: HealthRegistry,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    metrics: MetricsService,
  ) {
    this.gauge = metrics.gauge('health_check_status', 'Readiness check result: 1 ok, 0.5 warn, 0 fail', ['check']);
  }

  onModuleInit(): void {
    this.registry.register('database', {
      critical: true,
      run: async () => {
        await this.db.$queryRaw`SELECT 1`;
        return { status: 'ok' };
      },
    });
    this.registry.register('redis_state', {
      critical: true,
      run: async () => ((await this.redis.getClient().ping()) === 'PONG' ? { status: 'ok' } : { status: 'fail' }),
    });
    this.registry.register('redis_cache', {
      // Кэш теряем без вреда корректности: читатели уходят в базу — деградация, не отказ
      critical: false,
      run: async () => {
        if (!this.redis.cacheIsSeparate) return { status: 'skipped', detail: { reason: 'shared_with_state' } };
        return (await this.redis.cache.client.ping()) === 'PONG' ? { status: 'ok' } : { status: 'warn' };
      },
    });
  }

  async ready(): Promise<HealthReport> {
    const now = Date.now();
    if (this.memo && now - this.memo.at < REPORT_TTL_MS) return this.memo.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.collect()
      .then((report) => {
        this.memo = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async collect(): Promise<HealthReport> {
    const entries = this.registry.entries();
    const results = await Promise.all(
      entries.map(async ([name, check]) => {
        const started = Date.now();
        const r = await runWithTimeout(check);
        // Некритичный провал — предупреждение для итога (инстанс готов)
        const res = !check.critical && r.status === 'fail' ? { ...r, status: 'warn' as const } : r;
        this.gauge.set({ check: name }, res.status === 'ok' || res.status === 'skipped' ? 1 : res.status === 'warn' ? 0.5 : 0);
        return [name, { ...res, ms: Date.now() - started, critical: check.critical }] as const;
      }),
    );
    const checks = Object.fromEntries(results);
    const failed = results.some(([, r]) => r.critical && r.status === 'fail');
    const warned = results.some(([, r]) => r.status === 'warn' || r.status === 'fail');
    return { status: failed ? 'unavailable' : warned ? 'degraded' : 'ok', at: new Date().toISOString(), checks };
  }
}
