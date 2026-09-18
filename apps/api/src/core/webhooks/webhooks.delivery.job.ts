import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_LIMITS, WEBHOOK_SYSTEM_EVENTS } from '@superapp/shared';
import type { Counter } from 'prom-client';
import { DatabaseService } from '../../shared/database/database.service';
import { safeFetch } from '../../shared/http/safe-fetch';
import { trustedFetch } from '../../shared/http/trusted-fetch';
import { MetricsService } from '../../shared/metrics/metrics.service';
import { redactSecrets } from '../../shared/utils/redact';
import { JobDiscardError, JobSnoozeError, JobsRegistry, type JobContext } from '../jobs/jobs.registry';
import { KeysNotifier } from '../keys/api-keys/keys.notifications';
import { KeysAuditService } from '../keys/keys.audit.service';
import { WEBHOOK_AUDIT, WEBHOOK_JOBS, WEBHOOKS_QUEUE, WEBHOOKS_QUEUE_CONCURRENCY } from './webhooks.constants';
import { isLoopbackUrl, webhooksDevLoopback, WebhooksService } from './webhooks.service';
import { bogusSignatureHeaders, buildSignatureHeaders } from './webhooks.signing';

const USER_AGENT = 'SuperApp6-Webhooks/1';
const SYSTEM_ACTOR = { actorId: null, actorKind: 'system' } as const;

/**
 * Доставка вебхуков (core/jobs, очередь `webhooks`): один джоб = одна строка
 * WebhookDelivery; идемпотентно (доставленную не шлём второй раз); ответ 2xx = успех,
 * всё остальное (3xx тоже — редиректы не следуем) = провал с ретраем (бэкофф движка со
 * СВОИМ капом, до `WEBHOOK_LIMITS.maxAttempts`). Серия провалов endpoint'а считается
 * штуками И временем: автоотключение — только когда серия и длинная, и долгая.
 * Предохранитель: у адреса с серией провалов в сеть ходит одна пробная доставка за
 * паузу, остальные откладываются без расхода попыток (`JobSnoozeError`).
 * Пинг проверки (`webhook.ping`) переводит pending → active; не дождались 2xx за все
 * попытки пинга — disabled/verification. Аудит битой подписью — отдельный джоб:
 * 2xx на невалидную подпись → endpoint disabled.
 */
@Injectable()
export class WebhooksDeliveryJobs implements OnModuleInit {
  private readonly logger = new Logger(WebhooksDeliveryJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly webhooks: WebhooksService,
    private readonly audit: KeysAuditService,
    private readonly notifier: KeysNotifier,
    metrics: MetricsService,
  ) {
    this.deliveryFail = metrics.counter('webhooks_delivery_fail_total', 'Failed webhook delivery attempts by outcome', ['outcome']);
    this.deliveryOk = metrics.counter('webhooks_delivery_ok_total', 'Delivered webhook events');
    this.deliverySnoozed = metrics.counter('webhooks_delivery_snoozed_total', 'Deliveries postponed by the dead-endpoint circuit breaker');
  }

  /** Метрики (shared/metrics): провалы доставки по исходу (`retry` | `exhausted`), успехи, отложенные предохранителем */
  private readonly deliveryFail: Counter<string>;
  private readonly deliveryOk: Counter<string>;
  private readonly deliverySnoozed: Counter<string>;

  onModuleInit(): void {
    this.registry.register(WEBHOOK_JOBS.deliver, (p, ctx) => this.deliver(p, ctx), {
      queue: WEBHOOKS_QUEUE,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      backoffBaseMs: WEBHOOK_LIMITS.backoffBaseSec * 1000,
      // Свой кап: общий часовой кап движка джобов сжал бы окно ретраев с ~65 часов до ~5
      backoffCapMs: WEBHOOK_LIMITS.backoffCapSec * 1000,
      leaseMs: WEBHOOK_LIMITS.timeoutMs * 3,
      queueConcurrency: WEBHOOKS_QUEUE_CONCURRENCY,
      onDiscard: async (p) => {
        const id = typeof p.deliveryId === 'string' ? p.deliveryId : null;
        if (id) await this.db.webhookDelivery.updateMany({ where: { id, status: { in: ['pending', 'failed'] } }, data: { status: 'exhausted', nextAt: null } });
      },
    });
    // Cap — свойство ОЧЕРЕДИ (min по типам): у аудита он тот же, что у доставки, иначе аудит
    // сужал бы доставку. Волну аудита от доставок отделяет приоритет постановки (крон).
    this.registry.register(WEBHOOK_JOBS.probe, (p) => this.probe(p), { queue: WEBHOOKS_QUEUE, maxAttempts: 2, leaseMs: WEBHOOK_LIMITS.timeoutMs * 3, queueConcurrency: WEBHOOKS_QUEUE_CONCURRENCY });
  }

  /** POST на адрес endpoint'а: safeFetch (SSRF-щит, только публичные адреса); dev-loopback — trustedFetch. */
  private async post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; error: string | null }> {
    const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers }, body };
    try {
      const res = isLoopbackUrl(url) && webhooksDevLoopback()
        ? await trustedFetch(url, init, { timeoutMs: WEBHOOK_LIMITS.timeoutMs, origin: 'self' })
        : await safeFetch(url, init, { timeoutMs: WEBHOOK_LIMITS.timeoutMs, maxRedirects: 0 });
      // Тело ответа не читаем (получатель может отдать что угодно); соединение закрываем
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, error: null };
    } catch (err) {
      return { status: 0, error: redactSecrets(describeFetchError(err)).slice(0, 300) };
    }
  }

  /** Пауза предохранителя после `failures` провалов подряд: 30 с × 2^k, не дольше `circuitMaxSec`. */
  private circuitPauseMs(failures: number): number {
    const over = Math.min(Math.max(failures - WEBHOOK_LIMITS.circuitAfter, 0), 16);
    return Math.min(WEBHOOK_LIMITS.circuitMaxSec, WEBHOOK_LIMITS.circuitBaseSec * 2 ** over) * 1000;
  }

  /**
   * Предохранитель мёртвого адреса. Серия провалов ≥ `circuitAfter` — в сеть идёт ОДНА
   * пробная доставка за паузу: её берёт тот, кто атомарно передвинул `lastFailureAt`;
   * остальные откладываются без расхода попыток. Чёрная дыра одного арендатора иначе
   * держала бы все слоты общей очереди по 10 секунд на событие. Пауза конечна всегда:
   * либо пробная пройдёт (успех обнуляет серию), либо серия дорастёт до автоотключения.
   */
  private async passCircuit(e: WebhookEndpoint, deliveryId: string): Promise<void> {
    if (e.failures < WEBHOOK_LIMITS.circuitAfter) return;
    const pause = this.circuitPauseMs(e.failures);
    const { count } = await this.db.webhookEndpoint.updateMany({
      where: { id: e.id, OR: [{ lastFailureAt: null }, { lastFailureAt: { lt: new Date(Date.now() - pause) } }] },
      data: { lastFailureAt: new Date() },
    });
    if (count === 1) return;
    const left = e.lastFailureAt ? e.lastFailureAt.getTime() + pause - Date.now() : 0;
    const delay = (left > 0 ? left : pause) + Math.floor(Math.random() * 15_000);
    await this.db.webhookDelivery.updateMany({ where: { id: deliveryId, status: { in: ['pending', 'failed'] } }, data: { nextAt: new Date(Date.now() + delay) } });
    this.deliverySnoozed.inc();
    throw new JobSnoozeError(delay, `endpoint ${e.id}: circuit open after ${e.failures} failures`);
  }

  async deliver(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
    const deliveryId = typeof payload.deliveryId === 'string' ? payload.deliveryId : null;
    if (!deliveryId) throw new JobDiscardError('webhooks.deliver: deliveryId missing');
    const d = await this.db.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: { include: { workspace: { select: { isActive: true } } } } } });
    if (!d) throw new JobDiscardError('delivery row is gone');
    if (d.status === 'delivered' || d.status === 'exhausted') return;
    const e = d.endpoint;
    const isPing = d.eventKey === WEBHOOK_SYSTEM_EVENTS.ping;
    // Отключённый endpoint не получает ничего; pending получает только пинг проверки;
    // архивная организация наружу не говорит (хвост ретраев гаснет, статус endpoint'а цел —
    // восстановление организации вернёт всё как было)
    const blocked = !e.workspace.isActive ? 'workspace archived' : e.status === 'disabled' || (e.status === 'pending_verification' && !isPing) ? `endpoint ${e.status}` : null;
    if (blocked) {
      await this.db.webhookDelivery.update({ where: { id: d.id }, data: { status: 'exhausted', nextAt: null, lastError: blocked } });
      throw new JobDiscardError(blocked);
    }
    // Пинг — инструмент диагностики админа: предохранитель его не держит
    if (!isPing) await this.passCircuit(e, d.id);
    const body = JSON.stringify(d.payload);
    const msgId = (d.payload as { id?: string }).id ?? `msg_${d.id}`;
    const material = await this.webhooks.signingMaterial(e);
    const headers = buildSignatureHeaders(msgId, Math.floor(Date.now() / 1000), body, material);
    const res = await this.post(e.url, headers, body);
    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      this.deliveryOk.inc();
      let verified = false;
      await this.db.$transaction(async (tx) => {
        await tx.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts: ctx.attempt, nextAt: null, lastStatus: res.status, lastError: null, deliveredAt: new Date() } });
        await tx.webhookEndpoint.update({ where: { id: e.id }, data: { failures: 0, failingSince: null, lastFailureAt: null, lastDeliveryAt: new Date() } });
        if (isPing && e.status === 'pending_verification') {
          const { count } = await tx.webhookEndpoint.updateMany({ where: { id: e.id, status: 'pending_verification' }, data: { status: 'active' } });
          if (count) {
            await this.audit.log(tx, { ...SYSTEM_ACTOR, workspaceId: e.workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.verified });
            verified = true;
          }
        }
      });
      // Сокет владельцу и админам: «ждёт проверки» сменяется на «активен» без перезагрузки
      if (verified) void this.notifier.changed(e.workspaceId);
      return;
    }
    const last = ctx.attempt >= ctx.maxAttempts;
    this.deliveryFail.inc({ outcome: last ? 'exhausted' : 'retry' });
    const nextAt = last ? null : new Date(Date.now() + Math.min(WEBHOOK_LIMITS.backoffCapSec, WEBHOOK_LIMITS.backoffBaseSec * 2 ** (ctx.attempt - 1)) * 1000);
    let disabled = false;
    await this.db.$transaction(async (tx) => {
      await tx.webhookDelivery.update({ where: { id: d.id }, data: { status: last ? 'exhausted' : 'failed', attempts: ctx.attempt, nextAt, lastStatus: res.status || null, lastError: res.error ?? `HTTP ${res.status}` } });
      if (isPing) {
        // Пинг серию провалов не считает. Но не дождались 2xx за ВСЕ попытки — адрес не
        // подтверждён: endpoint не висит «ждёт проверки» вечно, а честно уходит в disabled.
        if (last) {
          const cur = await tx.webhookEndpoint.findUnique({ where: { id: e.id } });
          if (cur?.status === 'pending_verification') disabled = (await this.webhooks.disableTx(tx, cur, 'verification', SYSTEM_ACTOR, 'pending_verification')).status === 'disabled';
        }
        return;
      }
      const now = new Date();
      const fresh = await tx.webhookEndpoint.update({ where: { id: e.id }, data: { failures: { increment: 1 }, lastFailureAt: now } });
      if (!fresh.failingSince) await tx.webhookEndpoint.updateMany({ where: { id: e.id, failingSince: null }, data: { failingSince: now } });
      const failingMs = now.getTime() - (fresh.failingSince ?? now).getTime();
      // Порог штук И возраст серии: 50 событий за минуту перезапуска получателя — не повод
      if (fresh.status === 'active' && fresh.failures >= WEBHOOK_LIMITS.failuresToDisable && failingMs >= WEBHOOK_LIMITS.disableAfterHours * 3_600_000) {
        disabled = (await this.webhooks.disableTx(tx, fresh, 'failures', SYSTEM_ACTOR)).status === 'disabled';
      }
    });
    if (disabled) void this.notifier.changed(e.workspaceId);
    if (last) return;
    throw new Error(`webhook delivery failed: ${res.error ?? `HTTP ${res.status}`}`);
  }

  /** Аудит получателя: пинг с заведомо битой подписью. 2xx = подписи не проверяют → endpoint отключается. */
  async probe(payload: Record<string, unknown>): Promise<void> {
    const endpointId = typeof payload.endpointId === 'string' ? payload.endpointId : null;
    if (!endpointId) throw new JobDiscardError('webhooks.probe: endpointId missing');
    const e = await this.db.webhookEndpoint.findUnique({ where: { id: endpointId }, include: { workspace: { select: { isActive: true } } } });
    if (!e || e.status !== 'active' || !e.workspace.isActive) return;
    // Один id и в теле, и в заголовке — как у настоящей доставки
    const msgId = `msg_probe_${endpointId}_${Date.now()}`;
    const body = JSON.stringify({ id: msgId, type: WEBHOOK_SYSTEM_EVENTS.test, version: 1, occurredAt: new Date().toISOString(), data: { endpointId, probe: 'signature' } });
    const res = await this.post(e.url, bogusSignatureHeaders(msgId, Math.floor(Date.now() / 1000)), body);
    const accepted = res.status >= 200 && res.status < 300;
    let disabled = false;
    await this.db.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({ where: { id: e.id }, data: { lastProbeAt: new Date() } });
      if (accepted) {
        this.logger.warn(`webhook ${e.id} accepted a bogus signature — disabling`);
        disabled = (await this.webhooks.disableTx(tx, e, 'signature_audit', SYSTEM_ACTOR)).status === 'disabled';
      }
    });
    if (disabled) void this.notifier.changed(e.workspaceId);
  }
}

/**
 * Причина сетевого провала человеку-интегратору. `fetch` прячет суть в `cause`
 * («fetch failed» не говорит ничего): достаём код/текст причины; обрыв по таймеру
 * называем таймаутом.
 */
function describeFetchError(err: unknown): string {
  const e = err as (Error & { cause?: { code?: string; message?: string } }) | undefined;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return `Timed out after ${WEBHOOK_LIMITS.timeoutMs} ms`;
  const message = e?.message ?? String(err);
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause && !message.includes(cause) ? `${message}: ${cause}` : message;
}
