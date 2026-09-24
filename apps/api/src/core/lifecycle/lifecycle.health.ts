import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { LIFECYCLE_LIMITS } from '@superapp/shared';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { DatabaseService } from '../../shared/database/database.service';
import { isDevEnv } from '../../shared/config/env.validation';

/** Сигналы здоровья, по которым пачки purge ждут (GitLab/Atlassian: чистка не роняет прод). */
export interface LifecycleHealthSignals {
  /** Отставание реплик (с) — `pg_stat_replication.replay_lag` */
  replicationLagSec: number;
  /** Архив WAL падает (последняя ошибка свежее последнего успеха) — PITR под угрозой */
  archiverFailing: boolean;
  /** Идёт VACUUM по таблице политики — пачки только мешали бы ему */
  vacuumRunning: boolean;
  /** Темп WAL (байт/с) между замерами */
  walBytesPerSec: number;
  /** Сессий, ждущих блокировку */
  lockWaiters: number;
  /** p99 задержки цикла событий этого инстанса (мс) — прокси «API тормозит» */
  eventLoopP99Ms: number;
}

export interface LifecycleHealthVerdict {
  ok: boolean;
  /** Код первого сработавшего порога */
  reason: 'replication_lag' | 'archiver_failing' | 'vacuum_running' | 'wal_rate' | 'lock_waiters' | 'event_loop' | 'signals_unavailable' | null;
  signals: LifecycleHealthSignals;
}

/**
 * Здоровье БД перед каждой пачкой раннера: плохо — пачки ждут (`JobSnoozeError`), прогресс
 * прогона сохранён. Сигналы БД читает функция `lifecycle_health_signals` (миграция
 * `lifecycle_health_signals`): в проде её владелец — NOLOGIN-роль `sa6_monitor` с одним
 * `pg_read_all_stats` (db-roles.sql), приложение видит пять чисел, а не тексты чужих
 * запросов. Без прав монитора (dev) сигналы чужих процессов читаются нулём — fail-open
 * сознательно: отказ в здоровье остановил бы ретеншн навсегда, а метрика «отставание
 * ретеншна» — нет.
 *
 * Дев-полигон подменяет сигналы (`override`) — так сьют проверяет, что пачки ЖДУТ.
 */
@Injectable()
export class LifecycleHealth implements OnModuleDestroy {
  private readonly logger = new Logger(LifecycleHealth.name);
  private readonly loop: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  private wal: { at: number; bytes: bigint; rate: number } | null = null;
  private overrides: Partial<LifecycleHealthSignals> = {};

  constructor(private readonly db: DatabaseService) {
    this.loop.enable();
  }

  onModuleDestroy(): void {
    this.loop.disable();
  }

  /** Дев: подменить сигналы (пустой объект — снять подмену). Вне development — отказ. */
  override(signals: Partial<LifecycleHealthSignals>): void {
    if (!isDevEnv()) throw new Error('lifecycle health overrides are development-only');
    this.overrides = { ...signals };
  }

  async signals(table?: string | null): Promise<LifecycleHealthSignals> {
    const [row] = await this.db.$queryRaw<
      Array<{ lag: number | null; archiver_failing: boolean | null; vacuum: bigint; wal: string; lock_waiters: bigint }>
    >`SELECT lag, archiver_failing, vacuum, wal, lock_waiters FROM lifecycle_health_signals(to_regclass(${table ?? null}::text))`;
    const now = Date.now();
    const bytes = BigInt(row.wal.split('.')[0]);
    let rate = this.wal?.rate ?? 0;
    if (this.wal && now - this.wal.at >= 5_000) rate = Number(bytes - this.wal.bytes) / ((now - this.wal.at) / 1000);
    if (!this.wal || now - this.wal.at >= 5_000) this.wal = { at: now, bytes, rate };
    const p99 = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    const real: LifecycleHealthSignals = {
      replicationLagSec: Number(row.lag ?? 0),
      archiverFailing: Boolean(row.archiver_failing),
      vacuumRunning: Number(row.vacuum) > 0,
      walBytesPerSec: Math.max(0, rate),
      lockWaiters: Number(row.lock_waiters),
      eventLoopP99Ms: Number.isFinite(p99) ? p99 : 0,
    };
    return { ...real, ...this.overrides };
  }

  /** Вердикт по порогам `LIFECYCLE_LIMITS.health`; ошибка чтения сигналов — «плохо» (ждём). */
  async check(table?: string | null): Promise<LifecycleHealthVerdict> {
    let s: LifecycleHealthSignals;
    try {
      s = await this.signals(table);
    } catch (err) {
      this.logger.warn(`health signals unavailable: ${err instanceof Error ? err.message : err}`);
      return {
        ok: false,
        reason: 'signals_unavailable',
        signals: { replicationLagSec: 0, archiverFailing: false, vacuumRunning: false, walBytesPerSec: 0, lockWaiters: 0, eventLoopP99Ms: 0 },
      };
    }
    const h = LIFECYCLE_LIMITS.health;
    const reason: LifecycleHealthVerdict['reason'] =
      s.replicationLagSec > h.replicationLagSec
        ? 'replication_lag'
        : s.archiverFailing
          ? 'archiver_failing'
          : s.vacuumRunning
            ? 'vacuum_running'
            : s.walBytesPerSec > h.walBytesPerSec
              ? 'wal_rate'
              : s.lockWaiters > h.lockWaiters
                ? 'lock_waiters'
                : s.eventLoopP99Ms > h.eventLoopP99Ms
                  ? 'event_loop'
                  : null;
    return { ok: reason === null, reason, signals: s };
  }
}
