import type Redis from 'ioredis';
import type { Gauge } from 'prom-client';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * Лаг потока Redis Streams для метрик (docs/data_architecture.md): XADD с `MAXLEN ~` обрезает
 * и НЕПРОЧИТАННОЕ — отстающий потребитель теряет хвост молча. Тревога `lag > MAXLEN / 2`
 * (infra/prometheus/alerts.yml) звенит, пока хвост ещё цел. `lag` — поле XINFO GROUPS
 * (Redis ≥ 7: записи, ещё не выданные группе); `pending` — выданные без подтверждения.
 */
export class StreamLagGauges {
  private readonly lag: Gauge<string>;
  private readonly pending: Gauge<string>;
  private readonly length: Gauge<string>;
  private readonly cap: Gauge<string>;

  constructor(metrics: MetricsService) {
    this.lag = metrics.gauge('sa6_stream_lag', 'Entries of a Redis stream not yet delivered to its consumer group (alert > maxlen/2: tail loss at trim)', ['stream']);
    this.pending = metrics.gauge('sa6_stream_pending', 'Entries delivered to the consumer group but not acknowledged', ['stream']);
    this.length = metrics.gauge('sa6_stream_length', 'Entries in the Redis stream', ['stream']);
    this.cap = metrics.gauge('sa6_stream_maxlen', 'Approximate MAXLEN cap of the Redis stream (XADD trims unread entries above it)', ['stream']);
  }

  /** Сэмпл одной группы: без исключений наружу — диагностика не роняет цикл потребителя. */
  async sample(client: Redis, stream: string, group: string, maxLen: number): Promise<{ lag: number; pending: number; length: number } | null> {
    try {
      const groups = (await client.xinfo('GROUPS', stream)) as unknown[][];
      const row = groups.find((g) => fieldOf(g, 'name') === group);
      if (!row) return null;
      const length = Number(await client.xlen(stream));
      const pending = Number(fieldOf(row, 'pending') ?? 0);
      // lag = NULL у Redis, когда посчитать нельзя (удаления в середине) — берём длину как верхнюю оценку
      const rawLag = fieldOf(row, 'lag');
      const lag = rawLag === null || rawLag === undefined ? length : Number(rawLag);
      this.lag.set({ stream }, lag);
      this.pending.set({ stream }, pending);
      this.length.set({ stream }, length);
      this.cap.set({ stream }, maxLen);
      return { lag, pending, length };
    } catch {
      return null;
    }
  }
}

function fieldOf(row: unknown[], name: string): unknown {
  for (let i = 0; i + 1 < row.length; i += 2) if (row[i] === name) return row[i + 1];
  return undefined;
}
