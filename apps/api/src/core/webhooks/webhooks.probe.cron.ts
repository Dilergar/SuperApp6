import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WEBHOOK_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { RedisService } from '../../shared/redis/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { WEBHOOK_JOBS, WEBHOOK_LOCKS, WEBHOOK_PROBE_PRIORITY } from './webhooks.constants';

/** Строк за один проход минимизации: один UPDATE на миллионы строк — долгая транзакция и блоат. */
const REDACT_BATCH = 5_000;
/** Проходов за ночь (остаток доберётся завтра — крон ежедневный). */
const REDACT_MAX_PASSES = 200;

/**
 * Ежедневно: аудит битой подписью для живых endpoint'ов (раз в `probeIntervalHours`) и
 * минимизация тел доставок старше `bodyRetentionDays`. Сами строки живут по сроку политики
 * `WebhookDelivery` реестра и уходят сбросом месячной партиции (core/lifecycle). Под
 * Redis-локом — один инстанс.
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
      const redacted = await this.redactBodies();
      if (probes || redacted) this.logger.log(`webhooks daily: probes=${probes} bodies redacted=${redacted}`);
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

  /**
   * Тело доставки старше недели → отпечаток `{ redacted, id, type, sha256 }`: данные
   * организации (часто ПДн) не лежат у нас дольше, чем нужно для ретраев и разбора. Статус,
   * коды и время строки остаются для журнала доставок. Строка-сирота (pending/failed старше
   * окна ретраев — джоб потерян) закрывается как исчерпанная: отправлять больше нечего.
   */
  async redactBodies(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - WEBHOOK_LIMITS.bodyRetentionDays * 86_400_000);
    let total = 0;
    for (let pass = 0; pass < REDACT_MAX_PASSES; pass++) {
      const n = await this.db.$executeRaw`
        UPDATE webhook_deliveries d
        SET payload = jsonb_build_object('redacted', true, 'id', d.payload->'id', 'type', d.payload->'type',
                                         'sha256', encode(sha256(convert_to(d.payload::text, 'UTF8')), 'hex')),
            status = CASE WHEN d.status IN ('pending', 'failed') THEN 'exhausted' ELSE d.status END,
            next_at = CASE WHEN d.status IN ('pending', 'failed') THEN NULL ELSE d.next_at END
        FROM (
          SELECT id, created_at FROM webhook_deliveries
          WHERE created_at < ${utcTs(cutoff)} AND NOT (payload ? 'redacted')
          ORDER BY created_at
          LIMIT ${REDACT_BATCH}
        ) t
        WHERE d.id = t.id AND d.created_at = t.created_at`;
      total += n;
      if (n < REDACT_BATCH) break;
    }
    return total;
  }
}
