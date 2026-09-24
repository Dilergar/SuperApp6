import { Injectable } from '@nestjs/common';
import type { Counter, Gauge } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';

/**
 * Метрики движка жизненного цикла (`/metrics`). Метки — только имена родителей и коды
 * операций: ни id записей, ни организаций.
 *
 * Алерты (docs/lifecycle_engine.md): `lifecycle_partitions_ahead < 2` — месяц/день без
 * партиции близко (вставки упадут); `lifecycle_partitions_detach_pending > 0` дольше суток;
 * рост `lifecycle_partition_maintenance_errors_total`.
 */
@Injectable()
export class LifecycleMetrics {
  private readonly ahead: Gauge<string>;
  private readonly detachPending: Gauge<string>;
  private readonly leaves: Gauge<string>;
  private readonly dropped: Counter<string>;
  private readonly errors: Counter<string>;

  constructor(metrics: MetricsService) {
    this.ahead = metrics.gauge('lifecycle_partitions_ahead', 'Partitions from the current period onwards (current + future)', ['parent']);
    this.detachPending = metrics.gauge('lifecycle_partitions_detach_pending', 'Partitions stuck in «detach pending»', ['parent']);
    this.leaves = metrics.gauge('lifecycle_partitions_total', 'Attached partitions of a parent', ['parent']);
    this.dropped = metrics.counter('lifecycle_partitions_dropped_total', 'Partitions dropped by retention', ['parent']);
    this.errors = metrics.counter('lifecycle_partition_maintenance_errors_total', 'Partition maintenance failures (skipped, retried next run)', ['parent', 'op']);
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
}
