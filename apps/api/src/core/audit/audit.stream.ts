import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { auditEventDef, isWebhookEventKey, toOcsf, type AuditEventKey, type SecurityWebhookPayload, type WebhookEventKey } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { deviceFromFamily } from '../../shared/utils/user-agent';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { WebhooksRegistry } from '../webhooks/webhooks.registry';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AUDIT_PLATFORM_ONLY_DETAILS, auditActorKindOf, auditCategoryOf, auditClientOf, auditOutcomeOf } from './audit.codes';
import { AuditService, type AuditObservedEvent } from './audit.service';

type Tx = Prisma.TransactionClient;

/** Детали, которые наружу не уходят (служебные псевдонимы и снимки команд) — как у зрителя-организации */
const HIDDEN_DETAILS = AUDIT_PLATFORM_ONLY_DETAILS;
const PREFIX = 'security.';
/** Кэш «кто из организаций подписан на стрим» — не ходить в базу на каждую запись журнала */
const CACHE_TTL_MS = 30_000;

export const streamEventKey = (category: string): string => `${PREFIX}${category}.recorded`;

/**
 * Стрим журнала безопасности организации в её SIEM (core/audit, `audit.stream.ts`): событие с
 * `vis_workspace` → вебхук `security.<категория>.recorded` В ТРАНЗАКЦИИ ФАКТА (outbox движка
 * вебхуков: откат факта = доставки нет). Payload — OCSF без IP, UA и имён: только id, коды и
 * страна — стрим в SIEM не становится передачей ПДн третьему лицу (решение плана). Подписка —
 * тариф `audit.stream` (402 при подписке и тихий пропуск при доставке после понижения тарифа),
 * смена подписки — факт `org.audit.stream_changed` в журнале организации.
 */
@Injectable()
export class AuditStreamService implements OnModuleInit {
  private readonly logger = new Logger(AuditStreamService.name);
  private readonly subscribed = new Map<string, { until: number; keys: Set<string> }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
    private readonly webhooksRegistry: WebhooksRegistry,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit(): void {
    this.audit.observe('stream', { inTx: (tx, e) => this.onRecorded(tx, e) });
    this.webhooksRegistry.registerSubscriptionHook({
      prefix: PREFIX,
      onChange: async (tx, ctx) => {
        // Подписка на стрим — только на тарифе с `audit.stream`; отписка — всегда
        if (ctx.after.length) await this.entitlements.assertFeature(ctx.actorId, 'audit.stream', { type: 'workspace', id: ctx.workspaceId });
        this.subscribed.delete(ctx.workspaceId);
        await this.audit.record(tx, {
          key: 'org.audit.stream_changed',
          workspaceId: ctx.workspaceId,
          subjectUserId: ctx.actorId,
          details: { enabled: ctx.after.length > 0, categories: ctx.after.length },
        });
      },
    });
  }

  /**
   * Ключи `security.*`, на которые подписаны endpoint'ы организации (кэш 30 с). Ждущий проверки
   * endpoint тоже в наборе: события его же создания и проверки идут через журнал и иначе
   * закэшировали бы «подписок нет» на 30 с вперёд. Доставку всё равно фильтрует `emit` (только active).
   */
  private async keysOf(workspaceId: string, tx?: Tx | null): Promise<Set<string>> {
    const hit = this.subscribed.get(workspaceId);
    if (!tx && hit && hit.until > Date.now()) return hit.keys;
    // Внутри транзакции — её глазами и БЕЗ кэша: транзакция создания endpoint'а сама пишет в
    // журнал (keys.webhook.created), и чтение мимо неё закэшировало бы «подписок нет» на 30 с
    const rows = await (tx ?? this.db).webhookEndpoint.findMany({ where: { workspaceId, status: { in: ['active', 'pending_verification'] } }, select: { events: true } });
    const keys = new Set<string>();
    for (const r of rows) for (const k of Array.isArray(r.events) ? (r.events as string[]) : []) if (k.startsWith(PREFIX)) keys.add(k);
    if (!tx) this.subscribed.set(workspaceId, { until: Date.now() + CACHE_TTL_MS, keys });
    return keys;
  }

  /** Тариф `audit.stream` сейчас — одна проверка для живой доставки и повтора. Сбой резолва — нет (fail-closed). */
  private streamAllowed(workspaceId: string): Promise<boolean> {
    return this.entitlements.valueOf({ type: 'workspace', id: workspaceId }, 'audit.stream').then(
      (v) => v === true,
      () => false,
    );
  }

  private async onRecorded(tx: Tx | null, e: AuditObservedEvent): Promise<void> {
    if (!e.visWorkspace || !e.workspaceId) return;
    const eventKey = streamEventKey(e.def.category);
    if (!isWebhookEventKey(eventKey)) return;
    // Дешёвый отсев по кэшу; подписанную организацию перепроверяем глазами транзакции
    const cached = this.subscribed.get(e.workspaceId);
    if (cached && cached.until > Date.now() && !cached.keys.has(eventKey) && !tx) return;
    if (!(await this.keysOf(e.workspaceId, tx)).has(eventKey)) return;
    // Тариф могли понизить после подписки: доставки нет, подписка остаётся (вернут тариф — пойдёт)
    if (!(await this.streamAllowed(e.workspaceId))) return;
    await this.webhooks.emit(tx, { workspaceId: e.workspaceId, eventKey: eventKey as WebhookEventKey, payload: this.payload(e) as unknown as Record<string, unknown>, occurredAt: e.occurredAt });
  }

  payload(e: Pick<AuditObservedEvent, 'eventId' | 'key' | 'def' | 'occurredAt' | 'outcome' | 'reasonCode' | 'actorKind' | 'actorId' | 'subjectUserId' | 'workspaceId' | 'targetType' | 'targetId' | 'country' | 'client' | 'uaFamily' | 'requestId' | 'details'>): SecurityWebhookPayload {
    const details = Object.fromEntries(Object.entries(e.details).filter(([k]) => !HIDDEN_DETAILS.has(k)));
    const actor = { kind: e.actorKind, id: e.actorKind === 'platform_staff' ? null : e.actorId };
    const target = e.targetType && e.targetId ? { type: e.targetType, id: e.targetId } : null;
    return {
      schema: 1,
      eventId: e.eventId,
      key: e.key,
      category: e.def.category,
      occurredAt: e.occurredAt.toISOString(),
      severity: e.def.severity,
      outcome: e.outcome,
      actor: e.actorKind === 'platform_staff' ? { kind: 'platform', id: null } : actor,
      subjectUserId: e.subjectUserId,
      target,
      country: e.country,
      ocsf: toOcsf(e.def, {
        eventId: e.eventId,
        key: e.key,
        occurredAt: e.occurredAt.toISOString(),
        severity: e.def.severity,
        outcome: e.outcome,
        reasonCode: e.reasonCode,
        actor: e.actorKind === 'platform_staff' ? { kind: 'platform', id: null } : actor,
        subjectUserId: e.subjectUserId,
        workspaceId: e.workspaceId,
        target,
        country: e.country,
        deviceClass: deviceFromFamily(e.uaFamily).deviceClass,
        client: e.client,
        requestId: e.requestId,
        details,
      }) as unknown as Record<string, unknown>,
    };
  }

  /**
   * Повторить стрим за окно (команда Кабинета `security.stream.replay`): SIEM организации
   * потерял доставки. Только события, видимые организации, и только подписанные категории.
   */
  async replay(workspaceId: string, from: Date, to: Date): Promise<{ events: number }> {
    // Тариф — и на этом пути (как у живой доставки): после понижения повтор не доставляет
    if (!(await this.streamAllowed(workspaceId))) return { events: 0 };
    const keys = await this.keysOf(workspaceId);
    if (!keys.size) return { events: 0 };
    let events = 0;
    let after: { at: Date; id: bigint } | null = null;
    for (;;) {
      const rows: Array<{ id: bigint; eventId: string; occurredAt: Date; eventKey: string; category: number; severity: number; outcome: number; reasonCode: string | null; actorKind: number; actorId: string | null; subjectUserId: string | null; targetType: string | null; targetId: string | null; country: string | null; client: number | null; uaFamily: string | null; requestId: string | null; details: Prisma.JsonValue }> =
        await this.db.securityEvent.findMany({
          where: {
            workspaceId,
            visWorkspace: true,
            occurredAt: { gte: from, lte: to },
            ...(after ? { OR: [{ occurredAt: { gt: after.at } }, { occurredAt: after.at, id: { gt: after.id } }] } : {}),
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          take: 500,
          select: { id: true, eventId: true, occurredAt: true, eventKey: true, category: true, severity: true, outcome: true, reasonCode: true, actorKind: true, actorId: true, subjectUserId: true, targetType: true, targetId: true, country: true, client: true, uaFamily: true, requestId: true, details: true },
        });
      for (const r of rows) {
        const def = auditEventDef(r.eventKey);
        const category = auditCategoryOf(r.category);
        if (!def || !category) continue;
        const eventKey = streamEventKey(category);
        if (!keys.has(eventKey) || !isWebhookEventKey(eventKey)) continue;
        const payload = this.payload({
          eventId: r.eventId,
          key: r.eventKey as AuditEventKey,
          def,
          occurredAt: r.occurredAt,
          outcome: auditOutcomeOf(r.outcome),
          reasonCode: r.reasonCode,
          actorKind: auditActorKindOf(r.actorKind),
          actorId: r.actorId,
          subjectUserId: r.subjectUserId,
          workspaceId,
          targetType: r.targetType,
          targetId: r.targetId,
          country: r.country,
          client: auditClientOf(r.client),
          uaFamily: r.uaFamily,
          requestId: r.requestId,
          details: r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {},
        });
        events += await this.webhooks.emit(null, { workspaceId, eventKey: eventKey as WebhookEventKey, payload: payload as unknown as Record<string, unknown>, occurredAt: r.occurredAt });
      }
      if (rows.length < 500) break;
      const tail = rows[rows.length - 1]!;
      after = { at: tail.occurredAt, id: tail.id };
    }
    this.logger.log(`security stream replay for ${workspaceId}: ${events} deliveries`);
    return { events };
  }
}
