import { Injectable } from '@nestjs/common';
import type { Counter, Gauge } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';
import type { IdempotencyResult } from './idempotency.constants';

/**
 * Метрики движка (`/metrics`). Метки — только коды и признаки: ни ключа, ни id,
 * ни маршрута с параметрами.
 *
 * Всплеск `mismatch` — это либо баг клиента (переиспользует ключ), либо попытка
 * подобрать чужой ключ: на него ставится алерт (docs/idempotency_engine.md).
 */
@Injectable()
export class IdempotencyMetrics {
  private readonly requests: Counter<string>;
  private readonly atomicViolations: Counter<string>;
  private readonly rows: Gauge<string>;
  private readonly swept: Counter<string>;

  constructor(metrics: MetricsService) {
    this.requests = metrics.counter('idem_requests_total', 'Requests seen by the idempotency engine', ['result']);
    this.atomicViolations = metrics.counter(
      'idem_atomic_violations_total',
      'Handlers that promised atomic=true but committed more than one transaction (or wrote outside it)',
      ['route'],
    );
    this.rows = metrics.gauge('idem_keys_rows', 'Live rows in idem.keys');
    this.swept = metrics.counter('idem_keys_swept_total', 'Expired idempotency keys removed by the cleanup cron');
  }

  request(result: IdempotencyResult): void {
    this.requests.inc({ result });
  }

  atomicViolation(route: string): void {
    this.atomicViolations.inc({ route });
  }

  setRows(n: number): void {
    this.rows.set(n);
  }

  sweptRows(n: number): void {
    if (n > 0) this.swept.inc(n);
  }
}
