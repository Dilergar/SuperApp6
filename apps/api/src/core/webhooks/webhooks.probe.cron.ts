import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WEBHOOK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { WEBHOOK_JOBS, WEBHOOK_LOCKS, WEBHOOK_PROBE_PRIORITY } from './webhooks.constants';

/** Строк за один проход ретеншна: один DELETE на миллионы строк — долгая транзакция и блоат. */
const RETENTION_BATCH = 5_000;
/** Проходов ретеншна за ночь (остаток доберётся завтра — крон ежедневный). */
const RETENTION_MAX_PASSES = 200;

/**
 * Ежедневно: аудит битой подписью для живых endpoint'ов (раз в `probeIntervalHours`) и
 * ретеншн доставок (`deliveryRetentionDays`). Под Redis-локом — один инстанс.
 */
@Injectable()
export class WebhooksProbeCron {
  private readonly logger = new Logger(WebhooksProbeCron.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async daily(): Promise<void> {
    await this.redis.withLock(WEBHOOK_LOCKS.daily, 600_000, async () => {
      const probes = await this.enqueueProbes();
      const purged = await this.retention();
      if (probes || purged) this.logger.log(`webhooks daily: probes=${probes} purged=${purged}`);
    });
  }

  async enqueueProbes(): Promise<number> {
    const since = new Date(Date.now() - WEBHOOK_LIMITS.probeIntervalHours * 3_600_000);
    // Дольше всех не проверявшиеся — первыми: при потолке выборки хвост не голодает
    const rows = await this.db.webhookEndpoint.findMany({
      // Архивные организации не аудируем: запросов наружу от их имени быть не должно
      where: { status: 'active', workspace: { isActive: true }, OR: [{ lastProbeAt: null }, { lastProbeAt: { lt: since } }] },
      select: { id: true },
      orderBy: [{ lastProbeAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: 5000,
    });
    let n = 0;
    for (const r of rows) {
      const { inserted } = await this.jobs.enqueue(null, { type: WEBHOOK_JOBS.probe, payload: { endpointId: r.id }, uniqueKey: r.id, priority: WEBHOOK_PROBE_PRIORITY });
      if (inserted) n++;
    }
    return n;
  }

  async retention(): Promise<number> {
    // По возрасту, без оглядки на статус: окно ретраев ≈ 3 суток, значит строка старше 30 дней
    // в `pending`/`failed` — сирота (джоб потерян), и сама она не уйдёт никогда. Живой джоб
    // удалённой строки хоронит себя сам («delivery row is gone»).
    const cutoff = new Date(Date.now() - WEBHOOK_LIMITS.deliveryRetentionDays * 86_400_000);
    let total = 0;
    for (let pass = 0; pass < RETENTION_MAX_PASSES; pass++) {
      const batch = await this.db.webhookDelivery.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: RETENTION_BATCH });
      if (!batch.length) break;
      const { count } = await this.db.webhookDelivery.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
      total += count;
      if (batch.length < RETENTION_BATCH) break;
    }
    return total;
  }
}
