import { Injectable } from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';

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
