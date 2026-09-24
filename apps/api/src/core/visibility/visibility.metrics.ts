import { Injectable } from '@nestjs/common';
import type { Counter, Histogram } from 'prom-client';
import { MetricsService } from '../../shared/metrics/metrics.service';

/**
 * Метрики движка видимости (Prometheus `/metrics`). Метки — только коды типов записей,
 * исходов и признаков попадания в кэш; никогда id людей, организаций или полей с данными.
 */
@Injectable()
export class VisibilityMetrics {
  /** Факты о зрителе (роль + принципалы) — попадание в L1/L2 */
  readonly plan: Counter<string>;
  /** Опубликованные политики — попадание в L2 */
  readonly policyCache: Counter<string>;
  /** Раскрытия по исходу (`ok` / код отказа) */
  readonly reveals: Counter<string>;
  /** Отказы стража запроса (фильтр/сортировка/поиск по не-full полю) */
  readonly queryDenied: Counter<string>;
  /** Ответ с защищёнными полями без `shape()` (страж ответа) */
  readonly unshaped: Counter<string>;
  /** Вычисление решения упало → поле скрыто (fail-closed) */
  readonly failClosed: Counter<string>;
  /** Детекция скрейпинга: порог чужих строк с полями ≥ contact за час пройден */
  readonly scrape: Counter<string>;
  /** Латентность `shape` (пачка строк) */
  readonly shapeSeconds: Histogram<string>;

  constructor(metrics: MetricsService) {
    this.plan = metrics.counter('visibility_plan_total', 'Visibility viewer facts lookups', ['hit']);
    this.policyCache = metrics.counter('visibility_policy_cache_total', 'Visibility published policy cache lookups', ['hit']);
    this.reveals = metrics.counter('visibility_reveals_total', 'Visibility reveal requests', ['outcome']);
    this.queryDenied = metrics.counter('visibility_query_denied_total', 'Queries refused by the visibility query guard', ['record_type']);
    this.unshaped = metrics.counter('visibility_unshaped_total', 'Responses with guarded fields that bypassed shape()', ['record_type']);
    this.failClosed = metrics.counter('visibility_fail_closed_total', 'Field decisions that failed and were hidden', ['record_type']);
    this.scrape = metrics.counter('visibility_scrape_total', 'Scrape detections: hourly ceiling of exposed rows crossed', ['record_type']);
    this.shapeSeconds = metrics.histogram('visibility_shape_seconds', 'Visibility shape() latency per batch', [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25], ['record_type']);
  }
}
