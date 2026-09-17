import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WEBHOOK_LIMITS, WEBHOOK_SYSTEM_EVENTS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { safeFetch } from '../../shared/http/safe-fetch';
import { trustedFetch } from '../../shared/http/trusted-fetch';
import { redactSecrets } from '../../shared/utils/redact';
import { JobDiscardError, JobsRegistry, type JobContext } from '../jobs/jobs.registry';
import { WEBHOOK_AUDIT, WEBHOOK_JOBS, WEBHOOKS_QUEUE } from './webhooks.constants';
import { isLoopbackUrl, webhooksDevLoopback, WebhooksService } from './webhooks.service';
import { bogusSignatureHeaders, buildSignatureHeaders } from './webhooks.signing';
import { KeysAuditService } from '../keys/keys.audit.service';
import { MetricsService } from '../../shared/metrics/metrics.service';
import type { Counter } from 'prom-client';

const USER_AGENT = 'SuperApp6-Webhooks/1';

/**
 * Доставка вебхуков (core/jobs, очередь `webhooks`): один джоб = одна строка
 * WebhookDelivery; идемпотентно (доставленную не шлём второй раз); ответ 2xx = успех,
 * всё остальное (3xx тоже — редиректы не следуем) = провал с ретраем (бэкофф движка,
 * до `WEBHOOK_LIMITS.maxAttempts`); серия провалов endpoint'а → автоотключение +
 * уведомление владельцам. Пинг проверки (`webhook.ping`) переводит pending → active.
 * Аудит битой подписью — отдельный джоб: 2xx на невалидную подпись → endpoint disabled.
 */
@Injectable()
export class WebhooksDeliveryJobs implements OnModuleInit {
  private readonly logger = new Logger(WebhooksDeliveryJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly webhooks: WebhooksService,
    private readonly audit: KeysAuditService,
    metrics: MetricsService,
  ) {
    this.deliveryFail = metrics.counter('webhooks_delivery_fail_total', 'Failed webhook delivery attempts by outcome', ['outcome']);
    this.deliveryOk = metrics.counter('webhooks_delivery_ok_total', 'Delivered webhook events');
  }

  /** Метрики (shared/metrics): провалы доставки по исходу (`retry` | `exhausted`), успехи */
  private readonly deliveryFail: Counter<string>;
  private readonly deliveryOk: Counter<string>;

  onModuleInit(): void {
    this.registry.register(WEBHOOK_JOBS.deliver, (p, ctx) => this.deliver(p, ctx), {
      queue: WEBHOOKS_QUEUE,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      backoffBaseMs: WEBHOOK_LIMITS.backoffBaseSec * 1000,
      leaseMs: WEBHOOK_LIMITS.timeoutMs * 3,
      queueConcurrency: 8,
      onDiscard: async (p) => {
        const id = typeof p.deliveryId === 'string' ? p.deliveryId : null;
        if (id) await this.db.webhookDelivery.updateMany({ where: { id, status: { in: ['pending', 'failed'] } }, data: { status: 'exhausted', nextAt: null } });
      },
    });
    this.registry.register(WEBHOOK_JOBS.probe, (p) => this.probe(p), { queue: WEBHOOKS_QUEUE, maxAttempts: 2, leaseMs: WEBHOOK_LIMITS.timeoutMs * 3, queueConcurrency: 4 });
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
      return { status: 0, error: redactSecrets((err as Error).message ?? String(err)).slice(0, 300) };
    }
  }

  async deliver(payload: Record<string, unknown>, ctx: JobContext): Promise<void> {
    const deliveryId = typeof payload.deliveryId === 'string' ? payload.deliveryId : null;
    if (!deliveryId) throw new JobDiscardError('webhooks.deliver: deliveryId missing');
    const d = await this.db.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
    if (!d) throw new JobDiscardError('delivery row is gone');
    if (d.status === 'delivered') return;
    const e = d.endpoint;
    const isPing = d.eventKey === WEBHOOK_SYSTEM_EVENTS.ping;
    // Отключённый endpoint не получает ничего; pending получает только пинг проверки
    if (e.status === 'disabled' || (e.status === 'pending_verification' && !isPing)) {
      await this.db.webhookDelivery.update({ where: { id: d.id }, data: { status: 'exhausted', nextAt: null, lastError: `endpoint ${e.status}` } });
      throw new JobDiscardError(`endpoint ${e.status}`);
    }
    const body = JSON.stringify(d.payload);
    const msgId = (d.payload as { id?: string }).id ?? `msg_${d.id}`;
    const material = await this.webhooks.signingMaterial(e);
    const headers = buildSignatureHeaders(msgId, Math.floor(Date.now() / 1000), body, material);
    const res = await this.post(e.url, headers, body);
    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      this.deliveryOk.inc();
      await this.db.$transaction(async (tx) => {
        await tx.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts: ctx.attempt, nextAt: null, lastStatus: res.status, lastError: null, deliveredAt: new Date() } });
        await tx.webhookEndpoint.update({ where: { id: e.id }, data: { failures: 0, lastDeliveryAt: new Date() } });
        if (isPing && e.status === 'pending_verification') {
          const { count } = await tx.webhookEndpoint.updateMany({ where: { id: e.id, status: 'pending_verification' }, data: { status: 'active' } });
          if (count) await this.audit.log(tx, { actorId: null, actorKind: 'system', workspaceId: e.workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.verified });
        }
      });
      return;
    }
    const last = ctx.attempt >= ctx.maxAttempts;
    this.deliveryFail.inc({ outcome: last ? 'exhausted' : 'retry' });
    const nextAt = last ? null : new Date(Date.now() + Math.min(WEBHOOK_LIMITS.backoffCapSec, WEBHOOK_LIMITS.backoffBaseSec * 2 ** (ctx.attempt - 1)) * 1000);
    await this.db.$transaction(async (tx) => {
      await tx.webhookDelivery.update({ where: { id: d.id }, data: { status: last ? 'exhausted' : 'failed', attempts: ctx.attempt, nextAt, lastStatus: res.status || null, lastError: res.error ?? `HTTP ${res.status}` } });
      // Пинг проверки провалы endpoint'у не считает: он и так pending
      if (isPing) return;
      const fresh = await tx.webhookEndpoint.update({ where: { id: e.id }, data: { failures: { increment: 1 } } });
      if (fresh.failures >= WEBHOOK_LIMITS.failuresToDisable && fresh.status === 'active') {
        await this.webhooks.disableTx(tx, fresh, 'failures', { actorId: null, actorKind: 'system' });
      }
    });
    if (last) return;
    throw new Error(`webhook delivery failed: ${res.error ?? `HTTP ${res.status}`}`);
  }

  /** Аудит получателя: пинг с заведомо битой подписью. 2xx = подписи не проверяют → endpoint отключается. */
  async probe(payload: Record<string, unknown>): Promise<void> {
    const endpointId = typeof payload.endpointId === 'string' ? payload.endpointId : null;
    if (!endpointId) throw new JobDiscardError('webhooks.probe: endpointId missing');
    const e = await this.db.webhookEndpoint.findUnique({ where: { id: endpointId } });
    if (!e || e.status !== 'active') return;
    const body = JSON.stringify({ id: `msg_probe_${endpointId}_${Date.now()}`, type: WEBHOOK_SYSTEM_EVENTS.test, version: 1, occurredAt: new Date().toISOString(), data: { endpointId, probe: 'signature' } });
    const res = await this.post(e.url, bogusSignatureHeaders(`msg_probe_${Date.now()}`, Math.floor(Date.now() / 1000)), body);
    const accepted = res.status >= 200 && res.status < 300;
    await this.db.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({ where: { id: e.id }, data: { lastProbeAt: new Date() } });
      if (accepted) {
        this.logger.warn(`webhook ${e.id} accepted a bogus signature — disabling`);
        await this.webhooks.disableTx(tx, e, 'signature_audit', { actorId: null, actorKind: 'system' });
      }
    });
  }
}
