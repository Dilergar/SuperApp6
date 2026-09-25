import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type WebhookDelivery, type WebhookEndpoint } from '@prisma/client';

import {
  KEYS_ERROR_CODES,
  KEYS_REDIS,
  WEBHOOK_LIMITS,
  WEBHOOK_MANDATORY_EVENTS,
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
  type WebhookRotateSecretInput, lifecyclePolicy, uuidv7, uuidv7Time } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, notFound, tooMany } from '../../shared/errors/api-error';
import { assertPublicUrlShallow } from '../../shared/http/safe-fetch';
import { RedisService } from '../../shared/redis/redis.service';
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
import { byIdWithTimeHint } from '../lifecycle/lifecycle.time-hint';
import { LifecycleSettings } from '../lifecycle/lifecycle.settings';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { WEBHOOK_AUDIT, WEBHOOK_ENTITY, WEBHOOK_JOBS, isRedactedBody } from './webhooks.constants';
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

/** Адрес для показа за пределами раздела управления (уведомления): origin + путь, без query. */
export function publicUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

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
    private readonly redis: RedisService,
    private readonly lifecycleSettings: LifecycleSettings,
  ) {}

  /** Граница журнала доставок организации: её срок хранения (операционный класс) действует на чтении сразу. */
  private deliveriesCutoff(workspaceId: string): Promise<Date | null> {
    return this.lifecycleSettings.readCutoff(lifecyclePolicy('WebhookDelivery')!, workspaceId);
  }

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

  /**
   * Событие наружу: строки доставок + джобы в транзакции продюсера. Без подписчиков — no-op.
   * `tx = null` (у продюсера нет своей транзакции) — движок открывает собственную: строка
   * доставки без джоба висела бы в `pending` вечно, поэтому пара ложится атомарно ВСЕГДА.
   */
  async emit(tx: Tx | null, input: WebhookEmitInput): Promise<number> {
    if (!input.workspaceId) return 0;
    if (!tx) return this.db.$transaction((own) => this.emit(own, input));
    // Архивная организация наружу не говорит (системные пути — маршруты, кроны — её ещё трогают)
    const endpoints = await tx.webhookEndpoint.findMany({ where: { workspaceId: input.workspaceId, status: 'active', workspace: { isActive: true } }, select: { id: true, events: true } });
    const targets = endpoints.filter((e) => Array.isArray(e.events) && (e.events as string[]).includes(input.eventKey));
    if (!targets.length) return 0;
    const occurredAt = input.occurredAt ?? new Date();
    for (const e of targets) await this.createDelivery(tx, e.id, input.eventKey, input.payload, occurredAt);
    return targets.length;
  }

  /**
   * Обязательное событие стирания (`WEBHOOK_MANDATORY_EVENTS`, модель Shopify customers/redact ·
   * shop/redact): уходит ВСЕМ активным адресам организации без подписки — интеграция обязана
   * удалить у себя данные. `includeArchived` — только для `lifecycle.workspace.redact`: его
   * смысл и есть «организация отключена» (доставка пропускает его мимо шлюза архива).
   */
  async emitMandatory(tx: Tx, input: { workspaceId: string; eventKey: (typeof WEBHOOK_MANDATORY_EVENTS)[number]; payload: Record<string, unknown>; includeArchived?: boolean }): Promise<number> {
    if (!(WEBHOOK_MANDATORY_EVENTS as readonly string[]).includes(input.eventKey)) throw new Error(`webhooks: ${input.eventKey} is not a mandatory event`);
    const endpoints = await tx.webhookEndpoint.findMany({
      where: { workspaceId: input.workspaceId, status: 'active', ...(input.includeArchived ? {} : { workspace: { isActive: true } }) },
      select: { id: true },
    });
    const occurredAt = new Date();
    for (const e of endpoints) await this.createDelivery(tx, e.id, input.eventKey, input.payload, occurredAt);
    return endpoints.length;
  }

  /** Попыток у доставки: проверочный пинг короткий (~15 минут), событие — полное окно ретраев. */
  private attemptsFor(eventKey: string): number {
    return eventKey === WEBHOOK_SYSTEM_EVENTS.ping ? WEBHOOK_LIMITS.pingMaxAttempts : WEBHOOK_LIMITS.maxAttempts;
  }

  private async createDelivery(tx: Tx, endpointId: string, eventKey: string, data: Record<string, unknown>, occurredAt: Date): Promise<WebhookDelivery> {
    const id = uuidv7();
    const body = { id: `msg_${id}`, type: eventKey, version: this.registry.versionOf(eventKey), occurredAt: occurredAt.toISOString(), data };
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > WEBHOOK_LIMITS.maxPayloadBytes) throw badRequest('keys.webhook.payloadTooLarge', { bytes: size });
    // created_at — ключ месячной партиции: из того же момента, что и id (UUIDv7), — поиск
    // доставки по id потом сужается до одной партиции (byIdWithTimeHint)
    const createdAt = uuidv7Time(id) ?? new Date();
    const row = await tx.webhookDelivery.create({ data: { id, endpointId, eventKey, payload: body as Prisma.InputJsonObject, status: 'pending', nextAt: new Date(), createdAt } });
    await this.jobs.enqueue(tx, { type: WEBHOOK_JOBS.deliver, payload: { deliveryId: id }, uniqueKey: id, maxAttempts: this.attemptsFor(eventKey) });
    return row;
  }

  /**
   * Проверочный пинг. Живой пинг (pending | failed) у endpoint'а уже есть — второй не нужен:
   * пачка «Пинг»/«Включить» не копит очередь запросов на чужой адрес.
   */
  private async createPing(tx: Tx, endpointId: string, workspaceId: string): Promise<void> {
    const live = await tx.webhookDelivery.findFirst({ where: { endpointId, eventKey: WEBHOOK_SYSTEM_EVENTS.ping, status: { in: ['pending', 'failed'] } }, select: { id: true } });
    if (live) return;
    await this.createDelivery(tx, endpointId, WEBHOOK_SYSTEM_EVENTS.ping, { endpointId, workspaceId }, new Date());
  }

  /** Потолок ручных действий (пинг, повтор) на endpoint в час: платформа — не пушка по чужому адресу. */
  private async assertManualBudget(endpointId: string): Promise<void> {
    const key = KEYS_REDIS.webhookManual(endpointId, Math.floor(Date.now() / 3_600_000));
    const client = this.redis.getClient();
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, 3_600);
    if (n > WEBHOOK_LIMITS.manualActionsPerHour) throw tooMany('keys.webhook.tooManyManual');
  }

  // ------------------------------------------------------------
  // Управление endpoint'ами (owner/admin, step-up у создания и ротации)
  // ------------------------------------------------------------

  async list(actor: KeyActor, workspaceId: string): Promise<WebhookEndpointDto[]> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const rows = await this.db.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Адрес endpoint'а: только публичный https. Отказ сразу, у формы, — а не молчаливыми
   * провалами доставки потом. Логин/пароль в адресе запрещены (адрес виден в журнале,
   * реестре и уведомлениях; `fetch` такие адреса не принимает вовсе), фрагмент срезается.
   * Это ПРЕДпроверка: настоящий SSRF-щит (резолв имени, пин соединения) — в `safeFetch`
   * на каждой доставке, потому что имя хоста можно перевесить после создания.
   */
  private normalizeUrl(raw: string): string {
    const reject = () => badRequest('keys.webhook.url_rejected', undefined, { code: KEYS_ERROR_CODES.webhookUrlRejected });
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw reject();
    }
    if (u.username || u.password) throw reject();
    u.hash = '';
    const url = u.toString();
    if (isLoopbackUrl(url) && webhooksDevLoopback()) return url;
    if (u.protocol !== 'https:') throw reject();
    try {
      assertPublicUrlShallow(url);
    } catch {
      throw reject();
    }
    return url;
  }

  private ctx(workspaceId: string, field: string) {
    return { entity: WEBHOOK_ENTITY, field, ownerType: 'workspace', ownerId: workspaceId };
  }

  async create(actor: KeyActor, workspaceId: string, input: WebhookEndpointCreateInput): Promise<WebhookEndpointCreatedDto> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.stepUp.assert(actor.userId);
    const url = this.normalizeUrl(input.url);
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
        data: { workspaceId, url, events: events as Prisma.InputJsonValue, signing: input.signing, secretEnc, privateKeyEnc, publicKey, status: 'pending_verification', createdById: actor.userId },
      });
      // Группы событий со своими правилами (стрим журнала безопасности — тариф и факт в журнале)
      await this.registry.runSubscriptionHooks(tx, { actorId: actor.userId, workspaceId, before: [], after: events });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.created, ip: actor.ip ?? null, details: { signing: e.signing, events: events.length } });
      await this.analytics.track(tx, 'webhooks.endpoint.created', { signing: input.signing, eventCount: events.length }, { userId: actor.userId, workspaceId });
      // Проверка адреса: пинг с живой подписью; 2xx → active
      await this.createPing(tx, e.id, workspaceId);
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
        const before = Array.isArray(row.events) ? (row.events as string[]) : [];
        await this.registry.runSubscriptionHooks(tx, { actorId: actor.userId, workspaceId, before, after: events });
        u = await tx.webhookEndpoint.update({ where: { id }, data: { events: events as Prisma.InputJsonValue } });
        await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.updated, ip: actor.ip ?? null, details: { events: events.length } });
      }
      if (input.enabled === false && u.status !== 'disabled') {
        u = await this.disableTx(tx, u, 'manual', { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null });
      } else if (input.enabled === true && u.status === 'disabled') {
        // Отключённое платформой включает только платформа — иначе рычаг кабинета пустой
        if (u.disabledReason === 'platform') throw conflict('keys.webhook.platformDisabled');
        u = await this.enableTx(tx, u, { actorId: actor.userId, actorKind: 'user', ip: actor.ip ?? null });
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
      // Гвард по прежнему секрету: из двух одновременных ротаций побеждает одна — иначе
      // первому показали бы секрет, которого в базе уже нет ни текущим, ни предыдущим
      const { count } = await tx.webhookEndpoint.updateMany({ where: { id, secretEnc: row.secretEnc }, data: { secretEnc, prevSecretEnc, prevExpiresAt: prevSecretEnc ? new Date(Date.now() + input.prevHours * 3_600_000) : null } });
      if (count === 0) throw conflict('keys.webhook.rotationRace');
      const u = await tx.webhookEndpoint.findUniqueOrThrow({ where: { id } });
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
    await this.assertManualBudget(id);
    await this.db.$transaction((tx) => this.createPing(tx, id, workspaceId));
    return this.toDto(row);
  }

  async delete(actor: KeyActor, workspaceId: string, id: string): Promise<void> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    await this.db.$transaction(async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.registry.runSubscriptionHooks(tx, { actorId: actor.userId, workspaceId, before: Array.isArray(row.events) ? (row.events as string[]) : [], after: [] });
      await this.audit.log(tx, { actorId: actor.userId, workspaceId, subjectType: 'webhook_endpoint', subjectId: id, subjectName: row.url, action: WEBHOOK_AUDIT.deleted, ip: actor.ip ?? null });
    });
    void this.notifier.changed(workspaceId);
  }

  async deliveries(actor: KeyActor, workspaceId: string, id: string, q: WebhookDeliveriesQuery): Promise<WebhookDeliveryPage> {
    await this.keys.assertManager(actor.userId, workspaceId);
    await this.load(workspaceId, id);
    const limit = q.limit ?? WEBHOOK_LIMITS.recentDeliveries;
    // Курсор — id последней строки страницы; ключ таблицы составной (id, created_at), поэтому
    // страница продолжается keyset'ом по (created_at, id) от строки курсора
    const after = q.cursor
      ? await this.db.webhookDelivery.findFirst({ where: { ...byIdWithTimeHint(q.cursor), endpointId: id }, select: { id: true, createdAt: true } })
      : null;
    if (q.cursor && !after) return { items: [], nextCursor: null };
    const cutoff = await this.deliveriesCutoff(workspaceId);
    const rows = await this.db.webhookDelivery.findMany({
      where: {
        endpointId: id,
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { items: page.map((d) => this.toDeliveryDto(d)), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Повторная доставка: та же строка (тот же msg id), попытки с нуля. */
  async redeliver(actor: KeyActor, workspaceId: string, id: string, deliveryId: string): Promise<void> {
    await this.keys.assertManager(actor.userId, workspaceId);
    const row = await this.load(workspaceId, id);
    if (row.status === 'disabled') throw conflict('keys.webhook.disabled');
    const d = await this.db.webhookDelivery.findFirst({ where: { ...byIdWithTimeHint(deliveryId), endpointId: id } });
    // Старше срока хранения организации — строки для неё уже нет (удалит раннер)
    const cutoff = d ? await this.deliveriesCutoff(workspaceId) : null;
    if (!d || (cutoff && d.createdAt < cutoff)) throw notFound('keys.webhook.deliveryNotFound');
    // Тело старше недели заменено отпечатком (минимизация) — повторять нечего
    if (isRedactedBody(d.payload)) throw conflict('keys.webhook.deliveryBodyExpired');
    await this.assertManualBudget(id);
    await this.db.$transaction(async (tx) => {
      await tx.webhookDelivery.update({ where: { id_createdAt: { id: d.id, createdAt: d.createdAt } }, data: { status: 'pending', attempts: 0, nextAt: new Date(), lastError: null } });
      // Ждущий ретрая джоб этой же доставки снимаем: иначе постановка упёрлась бы в его
      // uniqueKey и «Повторить» молча ждал бы чужого бэкоффа со старым счётом попыток.
      // Исполняемый прямо сейчас не трогаем — он и есть доставка.
      await this.jobs.cancelByUniqueKey(tx, WEBHOOK_JOBS.deliver, deliveryId);
      await this.jobs.enqueue(tx, { type: WEBHOOK_JOBS.deliver, payload: { deliveryId }, uniqueKey: deliveryId, maxAttempts: this.attemptsFor(d.eventKey) });
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

  /**
   * Включение — общий путь организации и кабинета платформы: тариф → статус-гвард →
   * журнал → проверка адреса пингом (active он станет только по 2xx).
   */
  async enableTx(tx: Tx, e: WebhookEndpoint, actor: { actorId: string | null; actorKind: string; ip?: string | null }): Promise<WebhookEndpoint> {
    // Отключённые в расход тарифа не входят — значит включение обязано пройти тот же
    // потолок, что и создание: иначе «создал → выключил → создал → включил все» обходит лимит
    await this.entitlements.assertCanCreate(tx, { type: 'workspace', id: e.workspaceId }, 'webhooks.maxEndpoints');
    // Статус-гвард: из двух одновременных «Включить» переход (и пинг) делает один
    const { count } = await tx.webhookEndpoint.updateMany({ where: { id: e.id, status: 'disabled' }, data: { status: 'pending_verification', failures: 0, failingSince: null, lastFailureAt: null, disabledAt: null, disabledReason: null } });
    if (count) {
      await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: e.workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.enabled, ip: actor.ip ?? null });
      await this.createPing(tx, e.id, e.workspaceId);
    }
    return tx.webhookEndpoint.findUniqueOrThrow({ where: { id: e.id } });
  }

  /**
   * Замок платформы (команда кабинета): живой endpoint отключается, а уже отключённый
   * организацией или автоматикой ПЕРЕВОДИТСЯ под причину `platform` — иначе админ
   * включил бы его обратно одной кнопкой.
   */
  platformDisableTx(tx: Tx, e: WebhookEndpoint, actor: { actorId: string | null; actorKind: string }): Promise<WebhookEndpoint> {
    return this.disableTx(tx, e, 'platform', actor, undefined, true);
  }

  /**
   * Автоотключение / ручное отключение: статус, причина, уведомление владельцу и админам,
   * журнал, аналитика. `onlyFrom` сужает статус-гвард до одного исходного статуса
   * (провал проверки гасит только `pending_verification`, но не успевший стать active).
   * Проигравший гвард возвращает строку как была — вызывающий смотрит `status`.
   */
  async disableTx(tx: Tx, e: WebhookEndpoint, reason: WebhookDisabledReason, actor: { actorId: string | null; actorKind: string; ip?: string | null }, onlyFrom?: WebhookEndpointDto['status'], relock = false): Promise<WebhookEndpoint> {
    // `relock` — замок платформы поверх чужого отключения: гвард пропускает всё, кроме уже стоящего замка
    const guard: Prisma.WebhookEndpointWhereInput = relock ? { NOT: { status: 'disabled', disabledReason: reason } } : { status: onlyFrom ?? { not: 'disabled' } };
    const { count } = await tx.webhookEndpoint.updateMany({ where: { id: e.id, ...guard }, data: { status: 'disabled', disabledAt: new Date(), disabledReason: reason } });
    if (count === 0) return e;
    await this.audit.log(tx, { actorId: actor.actorId, actorKind: actor.actorKind, workspaceId: e.workspaceId, subjectType: 'webhook_endpoint', subjectId: e.id, subjectName: e.url, action: WEBHOOK_AUDIT.disabled, ip: actor.ip ?? null, details: { reason } });
    await this.analytics.track(tx, 'webhooks.endpoint.disabled', { reason }, { userId: actor.actorId ?? undefined, workspaceId: e.workspaceId });
    const to = await this.notifier.managers(e.workspaceId);
    if (to.length) {
      // Без .catch: сбой запроса внутри tx всё равно рвёт транзакцию — проглоченная ошибка
      // всплыла бы невнятным провалом коммита. Уведомление атомарно с отключением.
      await this.notifications.send(tx, {
        type: 'webhook.endpoint.disabled',
        to: to.map((userId) => ({ userId })),
        // В пуш и SMS адрес уходит БЕЗ query: токены получателя часто живут именно там
        payload: { url: publicUrlLabel(e.url), reasonLabelKey: `keys.webhook.disabledReason.${reason}` },
        ref: { type: WEBHOOK_NOTIFICATION_REF_TYPE, id: e.id },
        workspaceId: e.workspaceId,
        actorId: actor.actorId,
        reason: 'owner',
      });
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
