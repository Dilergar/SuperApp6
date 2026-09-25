import { Injectable } from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';

/**
 * Сторожевые сигналы БД (`LifecycleDbWatch`, раз в 5 минут КАЖДЫЙ инстанс — правила берут
 * `max without(instance)`). Пороги → действие — infra/prometheus/alerts.yml.
 */
const DB_SIGNALS = {
  xid_age: ['lifecycle_db_xid_age', 'Age of datfrozenxid of the database (transactions; warn 500M, page 1B)'],
  mxid_age: ['lifecycle_db_mxid_age', 'Age of datminmxid of the database (multixacts)'],
  relfrozenxid_age: ['lifecycle_db_oldest_relfrozenxid_age', 'Largest age(relfrozenxid) among tables'],
  size_bytes: ['lifecycle_db_size_bytes', 'Database size'],
  connections: ['lifecycle_db_connections', 'Client backends of the database'],
  connections_active: ['lifecycle_db_connections_active', 'Client backends running a query'],
  connections_idle_tx: ['lifecycle_db_connections_idle_in_transaction', 'Client backends idle inside a transaction'],
  max_connections: ['lifecycle_db_max_connections', 'max_connections setting'],
  lock_waiters: ['lifecycle_db_lock_waiters', 'Backends waiting for a heavyweight lock'],
  lockmanager_waits: ['lifecycle_db_lwlock_lockmanager_waits', 'Backends waiting on LWLock:LockManager (fast-path slots exhausted)'],
  replicas: ['lifecycle_db_replicas', 'Streaming replicas attached'],
  replay_lag_seconds: ['lifecycle_db_replay_lag_seconds', 'Largest replay lag among replicas (warn 1s, page 10s)'],
  invalid_indexes: ['lifecycle_db_invalid_indexes', 'Invalid indexes (failed CONCURRENTLY builds)'],
  detach_pending: ['lifecycle_db_detach_pending', 'Partitions stuck in «detach pending»'],
  cache_hit_ratio: ['lifecycle_db_cache_hit_ratio', 'Share of block reads served by shared buffers (alert < 0.99)'],
  temp_bytes: ['lifecycle_db_temp_bytes', 'Cumulative bytes written to temporary files'],
  temp_files: ['lifecycle_db_temp_files', 'Cumulative temporary files created'],
  deadlocks: ['lifecycle_db_deadlocks', 'Cumulative deadlocks detected'],
  checkpoints_requested_ratio: ['lifecycle_db_checkpoints_requested_ratio', 'Share of checkpoints requested (not timed); alert > 0.1 — max_wal_size too small'],
  slot_retained_wal_bytes: ['lifecycle_db_slot_retained_wal_bytes', 'WAL retained by the most lagging replication slot'],
  slot_wal_cap_bytes: ['lifecycle_db_slot_wal_cap_bytes', 'max_slot_wal_keep_size in bytes (-1 = unlimited)'],
  slots_inactive: ['lifecycle_db_slots_inactive', 'Replication slots with no consumer attached'],
  archive_failed: ['lifecycle_db_archive_failed', 'Cumulative failed WAL archive attempts'],
  archive_last_success_seconds: ['lifecycle_db_archive_last_success_seconds', 'Unix time of the last archived WAL segment (0 = never)'],
  longest_tx_seconds: ['lifecycle_db_longest_transaction_seconds', 'Age of the oldest open client transaction'],
} as const;
export type LifecycleDbSignal = keyof typeof DB_SIGNALS;

/**
 * Метрики движка жизненного цикла (`/metrics`). Метки — только имена родителей и коды
 * операций: ни id записей, ни организаций.
 *
 * Алерты (docs/lifecycle_engine.md): `lifecycle_partitions_ahead < 2` — месяц/день без
 * партиции близко (вставки упадут); `lifecycle_partitions_detach_pending > 0` дольше суток;
 * рост `lifecycle_partition_maintenance_errors_total`; любой `lifecycle_purge_halted_total`
 * (кэп радиуса / факт обогнал ожидание — человек смотрит ДО следующей ночи); рост
 * `lifecycle_loose_fk_backlog` дольше суток; `lifecycle_tenant_purge_step_failures_total`;
 * `lifecycle_erasure_stuck > 0` (стирание без прогресса больше 7 дней — DELF: застревание
 * на 45 дней); `lifecycle_erasure_failed > 0` (стирание остановилось ошибкой и само не
 * продолжится — повтор командой Кабинета); любой `lifecycle_canary_failures_total` (стирание где-то протекает);
 * `time() - lifecycle_canary_last_success_seconds > 2 суток` (канарейка не бежит);
 * `lifecycle_canary_unseeded_policies > 0` (хранилище плана стирания канарейка не проверяет).
 */
@Injectable()
export class LifecycleMetrics {
  private readonly ahead: Gauge<string>;
  private readonly detachPending: Gauge<string>;
  private readonly leaves: Gauge<string>;
  private readonly dropped: Counter<string>;
  private readonly errors: Counter<string>;
  private readonly purgeRows: Counter<string>;
  private readonly purgeBatches: Histogram<string>;
  private readonly purgeHalts: Counter<string>;
  private readonly purgeSnoozes: Counter<string>;
  private readonly purgeTimeouts: Counter<string>;
  private readonly tenantSteps: Histogram<string>;
  private readonly tenantFailures: Counter<string>;
  private readonly looseBacklog: Gauge<string>;
  private readonly looseProcessed: Counter<string>;
  private readonly holds: Counter<string>;
  private readonly erasureStages: Counter<string>;
  private readonly erasureRows: Counter<string>;
  private readonly erasureStuck: Gauge<string>;
  private readonly erasureHeld: Gauge<string>;
  private readonly erasureFailed: Gauge<string>;
  private readonly canaryFailures: Counter<string>;
  private readonly canaryLastOk: Gauge<string>;
  private readonly canaryUnseeded: Gauge<string>;
  private readonly dbSignals: Record<LifecycleDbSignal, Gauge<string>>;
  private readonly backupLastOk: Gauge<string>;
  private readonly drillLastOk: Gauge<string>;
  private readonly retentionLagging: Gauge<string>;
  private readonly retentionMaxLag: Gauge<string>;
  private readonly watchLastOk: Gauge<string>;

  constructor(metrics: MetricsService) {
    this.ahead = metrics.gauge('lifecycle_partitions_ahead', 'Partitions from the current period onwards (current + future)', ['parent']);
    this.detachPending = metrics.gauge('lifecycle_partitions_detach_pending', 'Partitions stuck in «detach pending»', ['parent']);
    this.leaves = metrics.gauge('lifecycle_partitions_total', 'Attached partitions of a parent', ['parent']);
    this.dropped = metrics.counter('lifecycle_partitions_dropped_total', 'Partitions dropped by retention', ['parent']);
    this.errors = metrics.counter('lifecycle_partition_maintenance_errors_total', 'Partition maintenance failures (skipped, retried next run)', ['parent', 'op']);
    this.purgeRows = metrics.counter('lifecycle_purge_rows_total', 'Rows deleted by the retention runner', ['policy']);
    this.purgeBatches = metrics.histogram('lifecycle_purge_batch_seconds', 'Duration of one purge batch', [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], ['policy']);
    this.purgeHalts = metrics.counter('lifecycle_purge_halted_total', 'Purge runs stopped by the blast-radius cap or an overrun of the expectation', ['policy', 'reason']);
    this.purgeSnoozes = metrics.counter('lifecycle_purge_snoozed_total', 'Purge batches postponed by database health gates', ['reason']);
    this.purgeTimeouts = metrics.counter('lifecycle_purge_batch_timeouts_total', 'Purge batches cancelled by lock/statement timeouts', ['policy']);
    this.tenantSteps = metrics.histogram('lifecycle_tenant_purge_step_seconds', 'Duration of one organisation purge step', [0.1, 1, 5, 30, 120, 600], ['step']);
    this.tenantFailures = metrics.counter('lifecycle_tenant_purge_step_failures_total', 'Organisation purge steps that threw (the cascade stops and retries)', ['step']);
    this.looseBacklog = metrics.gauge('lifecycle_loose_fk_backlog', 'Deleted parent rows whose loose-FK children are not processed yet');
    this.looseProcessed = metrics.counter('lifecycle_loose_fk_processed_total', 'Deleted parent rows whose loose-FK children were processed', ['table']);
    this.holds = metrics.counter('lifecycle_holds_changes_total', 'Legal holds placed and released', ['action', 'scope']);
    this.erasureStages = metrics.counter('lifecycle_erasure_stages_total', 'Erasure stages passed', ['subject_type', 'stage']);
    this.erasureRows = metrics.counter('lifecycle_erasure_rows_total', 'Rows erased, pseudonymized or redacted by subject erasure steps', ['step']);
    this.erasureStuck = metrics.gauge('lifecycle_erasure_stuck', 'Erasure requests without progress for more than the SLO (waiting for backups excluded)');
    this.erasureHeld = metrics.gauge('lifecycle_erasure_held', 'Erasure requests waiting for a legal hold to be released');
    this.erasureFailed = metrics.gauge('lifecycle_erasure_failed', 'Erasure requests stopped by an error (no automatic progress until retried)');
    this.canaryFailures = metrics.counter('lifecycle_canary_failures_total', 'Canary runs that found a trace of an erased synthetic subject', ['store']);
    this.canaryLastOk = metrics.gauge('lifecycle_canary_last_success_seconds', 'Unix time of the last clean canary run');
    this.canaryUnseeded = metrics.gauge('lifecycle_canary_unseeded_policies', 'Stores of the erasure plan the last canary run did not seed (not verified)');
    this.dbSignals = Object.fromEntries(
      (Object.keys(DB_SIGNALS) as LifecycleDbSignal[]).map((k) => [k, metrics.gauge(DB_SIGNALS[k][0], DB_SIGNALS[k][1])]),
    ) as Record<LifecycleDbSignal, Gauge<string>>;
    this.backupLastOk = metrics.gauge('lifecycle_backup_last_success_seconds', 'Unix time of the last successful full/incr/diff backup per repository (alert on ABSENCE, not on error mail)', ['repo']);
    this.drillLastOk = metrics.gauge('lifecycle_backup_last_drill_success_seconds', 'Unix time of the last successful restore/PITR/DR drill (0 = never)');
    this.retentionLagging = metrics.gauge('lifecycle_retention_lagging_policies', 'Policies whose oldest row is older than retention + tolerance');
    this.retentionMaxLag = metrics.gauge('lifecycle_retention_max_lag_days', 'Largest retention lag among policies, days');
    this.watchLastOk = metrics.gauge('lifecycle_db_watch_last_success_seconds', 'Unix time of the last successful database watch (alert when stale: silent metrics = Stripe 2019)');
  }

  dbSignal(values: Partial<Record<LifecycleDbSignal, number | null>>): void {
    for (const [k, v] of Object.entries(values) as Array<[LifecycleDbSignal, number | null]>) {
      if (v !== null && v !== undefined && Number.isFinite(v)) this.dbSignals[k].set(v);
    }
  }

  backupFreshness(repos: ReadonlyArray<{ repo: string; lastSuccessAt: string | null }>, lastDrillOkAt: string | null): void {
    for (const r of repos) this.backupLastOk.set({ repo: r.repo }, r.lastSuccessAt ? Math.floor(new Date(r.lastSuccessAt).getTime() / 1000) : 0);
    this.drillLastOk.set(lastDrillOkAt ? Math.floor(new Date(lastDrillOkAt).getTime() / 1000) : 0);
  }

  retentionLag(lagging: number, maxLagDays: number): void {
    this.retentionLagging.set(lagging);
    this.retentionMaxLag.set(maxLagDays);
  }

  dbWatchOk(at: Date): void {
    this.watchLastOk.set(Math.floor(at.getTime() / 1000));
  }

  health(parent: string, h: { ahead: number; detachPending: number; leaves: number }): void {
    this.ahead.set({ parent }, h.ahead);
    this.detachPending.set({ parent }, h.detachPending);
    this.leaves.set({ parent }, h.leaves);
  }

  droppedLeaves(parent: string, n: number): void {
    if (n > 0) this.dropped.inc({ parent }, n);
  }

  maintenanceError(parent: string, op: 'ensure' | 'drop' | 'analyze' | 'health'): void {
    this.errors.inc({ parent, op });
  }

  purgeBatch(policy: string, rows: number, ms: number): void {
    if (rows > 0) this.purgeRows.inc({ policy }, rows);
    this.purgeBatches.observe({ policy }, ms / 1000);
  }

  purgeHalted(policy: string, reason: string): void {
    this.purgeHalts.inc({ policy, reason });
  }

  purgeSnoozed(reason: string): void {
    this.purgeSnoozes.inc({ reason });
  }

  purgeTimeout(policy: string): void {
    this.purgeTimeouts.inc({ policy });
  }

  tenantStep(step: string, ms: number): void {
    this.tenantSteps.observe({ step }, ms / 1000);
  }

  tenantStepFailed(step: string): void {
    this.tenantFailures.inc({ step });
  }

  looseFkBacklog(n: number): void {
    this.looseBacklog.set(n);
  }

  looseFkProcessed(table: string, n: number): void {
    if (n > 0) this.looseProcessed.inc({ table }, n);
  }

  holdsChanged(action: 'created' | 'released', scope: string): void {
    this.holds.inc({ action, scope });
  }

  erasureStage(subjectType: string, stage: string): void {
    this.erasureStages.inc({ subject_type: subjectType, stage });
  }

  erasureStepRows(step: string, n: number): void {
    if (n > 0) this.erasureRows.inc({ step }, n);
  }

  erasureBacklog(stuck: number, held: number, failed: number): void {
    this.erasureStuck.set(stuck);
    this.erasureHeld.set(held);
    this.erasureFailed.set(failed);
  }

  canaryFailed(store: string): void {
    this.canaryFailures.inc({ store });
  }

  canaryOk(at: Date): void {
    this.canaryLastOk.set(Math.floor(at.getTime() / 1000));
  }

  canaryCoverage(unseeded: number): void {
    this.canaryUnseeded.set(unseeded);
  }
}
