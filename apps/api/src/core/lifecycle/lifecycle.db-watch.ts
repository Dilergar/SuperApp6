import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleMetrics } from './lifecycle.metrics';

interface OverviewRow {
  xid_age: bigint;
  mxid_age: bigint;
  db_bytes: bigint;
  connections: number;
  connections_active: number;
  connections_idle_tx: number;
  max_connections: number;
  lock_waiters: number;
  lwlock_lockmanager: number;
  replicas: number;
  max_replay_lag: number;
  invalid_indexes: number;
  detach_pending: number;
}

interface MetricsRow {
  cache_hit_ratio: number | null;
  temp_files: bigint | null;
  temp_bytes: bigint | null;
  deadlocks: bigint | null;
  checkpoints_timed: bigint | null;
  checkpoints_requested: bigint | null;
  slot_retained_wal_bytes: bigint | null;
  slots_inactive: number | null;
  slot_wal_cap_bytes: bigint | null;
  archive_failed: bigint | null;
  archive_last_success: Date | null;
  archive_last_failure: Date | null;
  longest_tx_seconds: number | null;
  oldest_relfrozenxid_age: bigint | null;
}

const num = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Сторожевые метрики БД (docs/data_architecture.md «Наблюдаемость»): сводки функций монитора
 * `lifecycle_db_overview()` + `lifecycle_db_metrics()` (числа; pg_read_all_stats у sa6_monitor,
 * приложению — EXECUTE), свежесть бэкапов и учений из отчётов скриптов, отставание сроков.
 * Пороги и действия — infra/prometheus/alerts.yml. Сбой опроса не бросает: метрика свежести
 * `lifecycle_db_watch_last_success_seconds` стареет, и тревога — на ОТСУТСТВИЕ сигнала.
 */
@Injectable()
export class LifecycleDbWatch {
  private readonly logger = new Logger(LifecycleDbWatch.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly metrics: LifecycleMetrics,
    private readonly dashboard: LifecycleDashboardService,
  ) {}

  async refresh(now = new Date()): Promise<boolean> {
    try {
      const [o, m] = await this.db.$transaction(
        async (tx) => {
          // Опрос каталога не имеет права висеть: блокировка на каталоге = пропуск тика, не очередь
          await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
          const [overview] = await tx.$queryRaw<OverviewRow[]>`SELECT * FROM lifecycle_db_overview()`;
          const [extra] = await tx.$queryRaw<MetricsRow[]>`SELECT * FROM lifecycle_db_metrics()`;
          return [overview, extra] as const;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
      const timed = num(m?.checkpoints_timed) ?? 0;
      const requested = num(m?.checkpoints_requested) ?? 0;
      this.metrics.dbSignal({
        xid_age: num(o?.xid_age),
        mxid_age: num(o?.mxid_age),
        relfrozenxid_age: num(m?.oldest_relfrozenxid_age),
        size_bytes: num(o?.db_bytes),
        connections: num(o?.connections),
        connections_active: num(o?.connections_active),
        connections_idle_tx: num(o?.connections_idle_tx),
        max_connections: num(o?.max_connections),
        lock_waiters: num(o?.lock_waiters),
        lockmanager_waits: num(o?.lwlock_lockmanager),
        replicas: num(o?.replicas),
        replay_lag_seconds: num(o?.max_replay_lag),
        invalid_indexes: num(o?.invalid_indexes),
        detach_pending: num(o?.detach_pending),
        cache_hit_ratio: num(m?.cache_hit_ratio),
        temp_bytes: num(m?.temp_bytes),
        temp_files: num(m?.temp_files),
        deadlocks: num(m?.deadlocks),
        checkpoints_requested_ratio: timed + requested > 0 ? requested / (timed + requested) : 0,
        slot_retained_wal_bytes: num(m?.slot_retained_wal_bytes),
        slot_wal_cap_bytes: num(m?.slot_wal_cap_bytes),
        slots_inactive: num(m?.slots_inactive),
        archive_failed: num(m?.archive_failed),
        archive_last_success_seconds: m?.archive_last_success ? Math.floor(m.archive_last_success.getTime() / 1000) : 0,
        longest_tx_seconds: num(m?.longest_tx_seconds),
      });
      const backups = await this.dashboard.backupFreshness();
      this.metrics.backupFreshness(backups.repos, backups.lastDrillOkAt);
      const lag = await this.dashboard.retentionLag();
      this.metrics.retentionLag(lag.lagging, lag.maxLagDays);
      this.metrics.dbWatchOk(now);
      return true;
    } catch (err) {
      this.logger.warn(`database watch failed (metrics go stale; the staleness alert fires): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
