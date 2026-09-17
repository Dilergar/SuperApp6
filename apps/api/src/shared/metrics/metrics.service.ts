import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Метрики платформы в формате Prometheus (text exposition 0.0.4) — один реестр на
 * процесс, отдаётся `GET /metrics` (вне префикса `/api`, гейт `METRICS_TOKEN`).
 * Движки регистрируют счётчики лениво по имени: повторная регистрация того же имени
 * возвращает тот же инструмент (модуль @Global, инстанс один). Имена — snake_case с
 * префиксом области (`keys_*`, `webhooks_*`), единицы — в суффиксе (`_seconds`, `_total`).
 * Метки — только коды и признаки (как в аналитике): ни id, ни текста, ни ПДн.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor() {
    // Память, event loop, GC, открытые дескрипторы — стандартный набор prom-client
    collectDefaultMetrics({ register: this.registry, prefix: 'sa6_' });
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter<string> {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter({ name, help, labelNames: [...labelNames], registers: [this.registry] });
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge<string> {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge({ name, help, labelNames: [...labelNames], registers: [this.registry] });
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []): Histogram<string> {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram({ name, help, buckets: [...buckets], labelNames: [...labelNames], registers: [this.registry] });
      this.histograms.set(name, h);
    }
    return h;
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
