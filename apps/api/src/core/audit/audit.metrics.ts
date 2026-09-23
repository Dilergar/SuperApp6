import { Injectable } from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';

/**
 * Метрики журнала безопасности (Prometheus `/metrics`). Метки — только коды категорий и
 * исходов, никогда id людей, ключи событий с данными или IP.
 */
@Injectable()
export class AuditMetrics {
  /** Записанные события по категории и исходу */
  readonly events: Counter<string>;
  /** Отказы записи: record (fail-closed, поднят вызывающему), best_effort, batch, batch_build */
  readonly writeFailures: Counter<string>;
  /** Латентность чтения ленты зрителем (subject | workspace | platform) */
  readonly queryLatency: Histogram<string>;
  /** Открытые тревоги детекций */
  readonly alertsOpen: Gauge<string>;
  /** Возраст последнего подписанного дайджеста (секунды) — отставание целостности */
  readonly digestLagSeconds: Gauge<string>;
  /** Сработавшие детекции по правилу */
  readonly detections: Counter<string>;
  /** Блокировки входа */
  readonly lockouts: Counter<string>;

  constructor(metrics: MetricsService) {
    this.events = metrics.counter('audit_events_total', 'Security events recorded', ['category', 'outcome']);
    this.writeFailures = metrics.counter('audit_write_failures_total', 'Security event write failures', ['path']);
    this.queryLatency = metrics.histogram('audit_query_latency_seconds', 'Security log read latency', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], ['viewer']);
    this.alertsOpen = metrics.gauge('audit_alerts_open', 'Open security detection alerts', ['severity']);
    this.digestLagSeconds = metrics.gauge('audit_digest_lag_seconds', 'Age of the newest signed security log digest');
    this.detections = metrics.counter('audit_detections_total', 'Security detections fired', ['rule']);
    this.lockouts = metrics.counter('audit_login_lockouts_total', 'Account sign-in lockouts');
  }
}
