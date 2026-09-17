import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type WebhookDelivery, type WebhookEndpoint } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  KEYS_ERROR_CODES,
  WEBHOOK_LIMITS,
  WEBHOOK_SYSTEM_EVENTS,
  type KeyRegistryRowDto,
  type WebhookDeliveriesQuery,
  type WebhookDeliveryDto,
  type WebhookDeliveryPage,
  type WebhookDisabledReason,
  type WebhookEndpointCreateInput,
  type WebhookEndpointCreatedDto,
  type WebhookEndpointDto,
  type WebhookEndpointUpdateInput,
  type WebhookEventKey,
  type WebhookRotateSecretInput,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { AnalyticsService } from '../analytics/analytics.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { JobsService } from '../jobs/jobs.service';
import { ApiKeysService, type KeyActor } from '../keys/api-keys/api-keys.service';
import { apiKeyEnv } from '../keys/api-keys/api-keys.common';
import { generateApiSecret } from '../keys/api-keys/api-keys.format';
import { KeysStepUpService } from '../keys/api-keys/keys-step-up.service';
import { KeysNotifier } from '../keys/api-keys/keys.notifications';
import { WebhooksRegistryPort } from '../keys/api-keys/webhooks.port';
import { KeysAuditService } from '../keys/keys.audit.service';
import { WEBHOOK_NOTIFICATION_REF_TYPE } from '../keys/keys.constants';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { ed25519RawPublic, generateEd25519 } from '../keys/keys.jwt';
import { KeysFieldRegistry } from '../keys/keys.registry';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { WEBHOOK_AUDIT, WEBHOOK_ENTITY, WEBHOOK_JOBS } from './webhooks.constants';
import { WebhooksRegistry } from './webhooks.registry';
import type { SigningMaterial } from './webhooks.signing';

type Tx = Prisma.TransactionClient;

export interface WebhookEmitInput {
  /** Организация-владелец события; `null` (личные данные) — событие никуда не уходит */
  workspaceId: string | null | undefined;
  eventKey: WebhookEventKey;
  /** Только коды, id и деловые поля; никогда ПДн третьих лиц и секреты */
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

const LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** Dev-полигон: доставка на loopback по http (сьют поднимает приёмник на 127.0.0.1). В production запрещено env-схемой. */
export const webhooksDevLoopback = (): boolean => isDevEnv() && process.env.WEBHOOKS_DEV_LOOPBACK === 'true';
export const isLoopbackUrl = (url: string): boolean => LOOPBACK_RE.test(url);

/**
 * core/webhooks — 23-й движок: исходящие вебхуки организации. Endpoint = адрес + события
 * + секрет подписи (envelope под KEK организации, show-once) + статус. Продюсер зовёт
 * `emit(tx, …)` В ТРАНЗАКЦИИ мутации: строки доставок и джобы ложатся атомарно с фактом
 * (outbox). Доставка — `webhooks.delivery.job.ts` (Standard Webhooks, safeFetch, ретраи,
 * автоотключение после серии провалов), аудит битой подписью — `webhooks.probe.cron.ts`.
 * Управление — владелец/админ организации (гейт `assertManager` движка ключей) под step-up.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly envelope: KeysEnvelopeService,
    private readonly fields: KeysFieldRegistry,
    private readonly jobs: JobsService,
    private readonly audit: KeysAuditService,
    private readonly notifications: NotificationsService,
    private readonly refs: NotificationRefRegistry,
    private readonly notifier: KeysNotifier,
    private readonly analytics: AnalyticsService,
    private readonly entitlements: EntitlementsService,
    private readonly port: WebhooksRegistryPort,
    private readonly stepUp: KeysStepUpService,
    private readonly keys: ApiKeysService,
    private readonly registry: WebhooksRegistry,
  ) {}

  onModuleInit(): void {
    // Секреты endpoint'а — envelope под KEK организации: rewrap при ротации KEK через реестр колонок
    for (const [column, field] of [['secret_enc', 'secret'], ['prev_secret_enc', 'prev_secret'], ['private_key_enc', 'private_key']] as const) {
      this.fields.register({ table: 'webhook_endpoints', idColumn: 'id', column, scope: 'workspace', scopeColumn: 'workspace_id', entity: WEBHOOK_ENTITY, field });
    }
    // Реестр ключей организации показывает endpoint'ы строками `webhook`; тариф считает живые
    this.port.register({ registryRows: (ws) => this.registryRows(ws), countLive: (ws) => this.db.webhookEndpoint.count({ where: { workspaceId: ws, status: { not: 'disabled' } } }) });
    this.refs.register(WEBHOOK_NOTIFICATION_REF_TYPE, {
      canViewMany: async (userIds, refId) => {
        const e = await this.db.webhookEndpoint.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        if (!e) return [];
        const allowed = new Set(await this.notifier.managers(e.workspaceId));
        return userIds.filter((id) => allowed.has(id));
      },
      href: (ref, ctx) => `/workspaces/${ctx.workspaceId ?? ''}/integrations?tab=webhooks&endpoint=${ref.id}`,
    });
  }

  // ------------------------------------------------------------
  // Продюсеры
  // ------------------------------------------------------------

  /** Событие наружу: строки доставок + джобы в транзакции продюсера. Без подписчиков — no-op. */
  async emit(tx: Tx | null, input: WebhookEmitInput): Promise<number> {
    if (!input.workspaceId) return 0;
    const client = tx ?? this.db;
    const endpoints = await client.webhookEndpoint.findMany({ where: { workspaceId: input.workspaceId, status: 'active' }, select: { id: true, events: true } });
    const targets = endpoints.filter((e) => Array.isArray(e.events) && (e.events as string[]).includes(input.eventKey));
    if (!targets.length) return 0;
    const occurredAt = input.occurredAt ?? new Date();
    for (const e of targets) await this.createDelivery(tx, e.id, input.eventKey, input.payload, occurredAt);
    return targets.length;
  }

  private async createDelivery(tx: Tx | null, endpointId: string, eventKey: string, data: Record<string, unknown>, occurredAt: Date): Promise<WebhookDelivery> {
    const client = tx ?? this.db;
    const id = randomUUID();
    const body = { id: `msg_${id}`, type: eventKey, version: this.registry.versionOf(eventKey), occurredAt: occurredAt.toISOString(), data };
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > WEBHOOK_LIMITS.maxPayloadBytes) throw badRequest('keys.webhook.payloadTooLarge', { bytes: size });
    const row = await client.webhookDelivery.create({ data: { id, endpointId, eventKey, payload: body as Prisma.InputJsonObject, status: 'pending', nextAt: new Date() } });
    await this.jobs.enqueue(tx, { type: WEBHOOK_JOBS.deliver, payload: { deliveryId: id }, uniqueKey: id, maxAttempts: WEBHOOK_LIMITS.maxAttempts });
    return row;
  }

  // ------------------------------------------------------------
  // Управление endpoint'ами (owner/admin, step-up у создания и ротации)
  // ------------------------------------------------------------

  async list(actor: KeyActor, workspaceId: string): Promise<WebhookEndpointDto[]> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const rows = await this.db.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  private assertUrl(url: string): void {
    if (/^https:\/\//i.test(url)) return;
    if (isLoopbackUrl(url) && webhooksDevLoopback()) return;
    throw badRequest('keys.webhook.url_rejected', undefined, { code: KEYS_ERROR_CODES.webhookUrlRejected });
  }

  private ctx(workspaceId: string, field: string) {
    return { entity: WEBHOOK_ENTITY, field, ownerType: 'workspace', ownerId: workspaceId };
  }

  async create(actor: KeyActor, workspaceId: string, input: WebhookEndpointCreateInput): Promise<WebhookEndpointCreatedDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    this.assertUrl(input.url);
    const events = this.registry.normalize(input.events);
    const secret = generateApiSecret('whs', apiKeyEnv()).secret;
    const scope = { type: 'workspace' as const, id: workspaceId };
    const secretEnc = await this.envelope.encrypt(scope, this.ctx(workspaceId, 'secret'), secret);
    let privateKeyEnc: string | null = null;
    let publicKey: string | null = null;
    if (input.signing === 'ed25519') {
      const pair = generateEd25519();
      privateKeyEnc = await this.envelope.encrypt(scope, this.ctx(workspaceId, 'private_key'), pair.privateKey.toString('base64'));
      publicKey = ed25519RawPublic(pair.publicKey).toString('base64');
    }
    const row = await this.db.$transaction(async (tx) => {
      await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: workspaceId }, 'webhooks.maxEndpoints');
      const e = await tx.webhookEndpoint.create({
        data: { workspaceId, url: input.url, events: events as Prisma.InputJsonValue, signing: input.signing, secretEnc, privateKeyEnc, publicKey, status: 'pending_verification', createdById: actor.userId },
      });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.created, ip: actor.ip ?? null, details: { signing: e.signing, events: events.length } });
      await this.analytics.track(tx, 'webhooks.endpoint.created', { signing: input.signing, eventCount: events.length }, { userId: actor.userId, workspaceId });
      // Проверка адреса: пинг с живой подписью; 2xx → active
      await this.createDelivery(tx, e.id, WEBHOOK_SYSTEM_EVENTS.ping, { endpointId: e.id, workspaceId }, new Date());
      return e;
    });
    void this.notifier.changed(workspaceId);
    return { endpoint: this.toDto(row), secret };
  }

  private async load(workspaceId: string, id: string): Promise<WebhookEndpoint> {
    const row = await this.db.webhookEndpoint.findUnique({ where: { id } });
    if (!row || row.workspaceId !== workspaceId) throw notFound('keys.webhook.notFound');
    return row;
  }

  async update(actor: KeyActor, workspaceId: string, id: string, input: WebhookEndpointUpdateInput): Promise<WebhookEndpointDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    const events = input.events !== undefined ? this.registry.normalize(input.events) : null;
    const updated = await this.db.$transaction(async (tx) => {
      let u = row;
      if (events) {
        u = await tx.webhookEndpoint.update({ where: { id }, data: { events: events as Prisma.InputJsonValue } });
        await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.updated, ip: actor.ip ?? null, details: { events: events.length } });
      }
      if (input.enabled === false && u.status !== 'disabled') {
        u = await this.disableTx(tx, u, 'manual', { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null });
      } else if (input.enabled === true && u.status === 'disabled') {
        // Включение — снова через проверку адреса: пинг решит, active ли он
        u = await tx.webhookEndpoint.update({ where: { id }, data: { status: 'pending_verification', failures: 0, disabledAt: null, disabledReason: null } });
        await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.enabled, ip: actor.ip ?? null });
        await this.createDelivery(tx, id, WEBHOOK_SYSTEM_EVENTS.ping, { endpointId: id, workspaceId }, new Date());
      }
      return u;
    });
    void this.notifier.changed(workspaceId);
    return this.toDto(updated);
  }

  /** Ротация секрета: новый секрет сразу, старый подписывает ещё `prevHours` (получатель принимает любую совпавшую подпись). */
  async rotateSecret(actor: KeyActor, workspaceId: string, id: string, input: WebhookRotateSecretInput): Promise<WebhookEndpointCreatedDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    const row = await this.load(workspaceId, id);
    const secret = generateApiSecret('whs', apiKeyEnv()).secret;
    const scope = { type: 'workspace' as const, id: workspaceId };
    const secretEnc = await this.envelope.encrypt(scope, this.ctx(workspaceId, 'secret'), secret);
    const prevSecretEnc = input.prevHours > 0 ? await this.envelope.encrypt(scope, this.ctx(workspaceId, 'prev_secret'), await this.envelope.decrypt(scope, this.ctx(workspaceId, 'secret'), row.secretEnc)) : null;
    const updated = await this.db.$transaction(async (tx) => {
      const u = await tx.webhookEndpoint.update({ where: { id }, data: { secretEnc, prevSecretEnc, prevExpiresAt: prevSecretEnc ? new Date(Date.now() + input.prevHours * 3_600_000) : null } });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.secretRotated, ip: actor.ip ?? null, details: { prevHours: input.prevHours } });
      return u;
    });
    return { endpoint: this.toDto(updated), secret };
  }

  /** Проверочный пинг руками (живая подпись): pending → active по 2xx. */
  async probe(actor: KeyActor, workspaceId: string, id: string): Promise<WebhookEndpointDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    if (row.status === 'disabled') throw conflict('keys.webhook.disabled');
    await this.db.$transaction((tx) => this.createDelivery(tx, id, WEBHOOK_SYSTEM_EVENTS.ping, { endpointId: id, workspaceId }, new Date()));
    return this.toDto(row);
  }

  async delete(actor: KeyActor, workspaceId: string, id: string): Promise<void> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    await this.db.$transaction(async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.deleted, ip: actor.ip ?? null });
    });
    void this.notifier.changed(workspaceId);
  }

  async deliveries(actor: KeyActor, workspaceId: string, id: string, q: WebhookDeliveriesQuery): Promise<WebhookDeliveryPage> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.load(workspaceId, id);
    const limit = q.limit ?? WEBHOOK_LIMITS.recentDeliveries;
    const rows = await this.db.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return { items: page.map((d) => this.toDeliveryDto(d)), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Повторная доставка: та же строка (тот же msg id), попытки с нуля. */
  async redeliver(actor: KeyActor, workspaceId: string, id: string, deliveryId: string): Promise<void> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    if (row.status === 'disabled') throw conflict('keys.webhook.disabled');
    const d = await this.db.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!d || d.endpointId !== id) throw notFound('keys.webhook.deliveryNotFound');
    await this.db.$transaction(async (tx) => {
      await tx.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'pending', attempts: 0, nextAt: new Date(), lastError: null } });
      await this.jobs.enqueue(tx, { type: WEBHOOK_JOBS.deliver, payload: { deliveryId }, uniqueKey: deliveryId, maxAttempts: WEBHOOK_LIMITS.maxAttempts });
    });
  }

  // ------------------------------------------------------------
  // Для джобов доставки
  // ------------------------------------------------------------

  /** Живые секреты endpoint'а (текущий + prev до срока) и приватный ключ Ed25519. */
  async signingMaterial(e: WebhookEndpoint): Promise<SigningMaterial> {
    const scope = { type: 'workspace' as const, id: e.workspaceId };
    const secrets = [await this.envelope.decrypt(scope, this.ctx(e.workspaceId, 'secret'), e.secretEnc)];
    if (e.prevSecretEnc && e.prevExpiresAt && e.prevExpiresAt.getTime() > Date.now()) {
      const prev = await this.envelope.tryDecrypt(scope, this.ctx(e.workspaceId, 'prev_secret'), e.prevSecretEnc);
      if (prev.ok) secrets.push(prev.value);
    }
    let ed25519PrivateKey: Buffer | null = null;
    if (e.signing === 'ed25519' && e.privateKeyEnc) {
      ed25519PrivateKey = Buffer.from(await this.envelope.decrypt(scope, this.ctx(e.workspaceId, 'private_key'), e.privateKeyEnc), 'base64');
    }
    return { secrets, ed25519PrivateKey };
  }

  /** Автоотключение / ручное отключение: статус, причина, уведомление владельцу и админам, журнал, аналитика. */
  async disableTx(tx: Tx, e: WebhookEndpoint, reason: WebhookDisabledReason, actor: { actorId: string | null; actorKind: string; ip?: string | null }): Promise<WebhookEndpoint> {
    const { count } = await tx.webhookEndpoint.updateMany({ where: { id: e.id, status: { not: 'disabled' } }, data: { status: 'disabled', disabledAt: new Date(), disabledReason: reason } });
    if (count === 0) return e;
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: e.workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.disabled, ip: actor.ip ?? null, details: { reason } });
    await this.analytics.track(tx, 'webhooks.endpoint.disabled', { reason }, { userId: actor.actorId ?? undefined, workspaceId: e.workspaceId });
    const to = await this.notifier.managers(e.workspaceId);
    if (to.length) {
      await this.notifications
        .send(tx, {
          type: 'webhook.endpoint.disabled',
          to: to.map((userId) => ({ userId })),
          payload: { url: e.url, reasonLabelKey: `keys.webhook.disabledReason.${reason}` },
          ref: { type: WEBHOOK_NOTIFICATION_REF_TYPE, id: e.id },
          workspaceId: e.workspaceId,
          actorId: actor.actorId,
          reason: 'owner',
        })
        .catch((err) => this.logger.warn(`notify webhook.endpoint.disabled ${e.id}: ${(err as Error).message}`));
    }
    return { ...e, status: 'disabled', disabledAt: new Date(), disabledReason: reason };
  }

  // ------------------------------------------------------------
  // Реестр ключей организации
  // ------------------------------------------------------------

  async registryRows(workspaceId: string): Promise<KeyRegistryRowDto[]> {
    const rows = await this.db.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((e) => {
      const events = Array.isArray(e.events) ? (e.events as string[]) : [];
      return {
        kind: 'webhook',
        id: e.id,
        name: e.url,
        holder: { kind: 'webhook', id: e.id, name: e.url },
        createdById: e.createdById,
        createdBy: null,
        createdAt: e.createdAt.toISOString(),
        purpose: events.join(', '),
        scopeCount: events.length,
        scopes: {},
        status: e.status as WebhookEndpointDto['status'],
        expiresInDays: null,
        expiresAt: null,
        lastUsedAt: e.lastDeliveryAt?.toISOString() ?? null,
        lastUsedLocation: null,
        lastUsedIp: null,
        frozenReason: null,
        botId: null,
      };
    });
  }

  toDto(e: WebhookEndpoint): WebhookEndpointDto {
    return {
      id: e.id,
      workspaceId: e.workspaceId,
      url: e.url,
      events: (Array.isArray(e.events) ? (e.events as string[]) : []) as WebhookEventKey[],
      signing: e.signing as WebhookEndpointDto['signing'],
      status: e.status as WebhookEndpointDto['status'],
      failures: e.failures,
      disabledAt: e.disabledAt?.toISOString() ?? null,
      disabledReason: (e.disabledReason as WebhookDisabledReason | null) ?? null,
      prevSecretUntil: e.prevExpiresAt && e.prevExpiresAt.getTime() > Date.now() ? e.prevExpiresAt.toISOString() : null,
      publicKey: e.publicKey,
      createdById: e.createdById,
      createdAt: e.createdAt.toISOString(),
      lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
    };
  }

  toDeliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
    return {
      id: d.id,
      endpointId: d.endpointId,
      eventKey: d.eventKey,
      status: d.status as WebhookDeliveryDto['status'],
      attempts: d.attempts,
      nextAt: d.nextAt?.toISOString() ?? null,
      lastStatus: d.lastStatus,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
    };
  }
}
