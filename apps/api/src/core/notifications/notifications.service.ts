import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { SOURCE_LOCALE } from '@superapp/shared';
import type { Locale } from '@superapp/i18n';
import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_PERSONAL_CONTEXT,
  RICH_CARD_REF_TYPES,
  notificationDef,
  type AudienceContext,
  type AudienceRef,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
  type NotificationActorDto,
  type NotificationChannel,
  type NotificationCountsDto,
  type NotificationDeliveryDto,
  type NotificationDto,
  type NotificationPageDto,
  type NotificationReason,
  type NotificationRef,
  type NotificationSendResult,
  type NotificationType,
  type NotificationWorkspaceDto,
  type NotificationsCountsBusPayload,
  type RichCardRefType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { utcTs } from '../../shared/database/sql-time';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { JobsService } from '../jobs/jobs.service';
import { NOTIFICATION_BUS_EVENTS, NOTIFICATION_JOBS, NOTIFICATION_REDIS } from './notifications.constants';
import { NotificationRefRegistry } from './notifications.registry';
import { NotificationsRenderer } from './notifications.render';
import { slidingPeek, slidingRecord } from './notifications.window';

type Tx = Prisma.TransactionClient;

/** Адресат `send`: человек · адресат core/audiences (отдел/должность/объект/руководитель) · чат (объект-получатель канала chat). */
export type NotificationRecipient = { userId: string } | AudienceRef | { chatId: string };

export interface SendNotificationInput {
  type: NotificationType;
  to: NotificationRecipient[];
  /** ICU-переменные + данные рич-рендера (только скаляры и id) */
  payload?: Record<string, unknown>;
  ref?: NotificationRef | null;
  actorId?: string | null;
  workspaceId?: string | null;
  reason?: NotificationReason;
  /** Свой ключ схлопывания (иначе — по стратегии типа) */
  collapseKey?: string;
  /** Идемпотентность у источника: повтор с тем же ключом — no-op (`null` в ответе) */
  idempotencyKey?: string;
  /** Переопределение deep link (иначе href(ref) из реестра) */
  actionUrl?: string | null;
  /** Редко: напр. только chat */
  channels?: Partial<Record<NotificationChannel, boolean>>;
  /** Актор по умолчанию вычитается из адресатов */
  includeActor?: boolean;
  audienceCtx?: Partial<AudienceContext>;
  /** Программируемые продюсеры (нода Процессов): скользящий бюджет организации */
  budget?: 'workspace';
}

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

/**
 * core/notifications — движок уведомлений (17-й).
 *
 * Контракт продюсера: `send(tx, {type, to, payload, ref?, actorId?, workspaceId?, …})` —
 * продюсер решает КОМУ (фича знает семантику), движок — КАК. Событие пишется В
 * ТРАНЗАКЦИИ продюсера вместе с джобом `notifications.fanout` (transactional outbox,
 * правило core/jobs); `tx = null` — только кроны/пост-коммит без транзакции.
 * Права `send` НЕ проверяет — проверяет вызывающий (как у всех system*-методов движков);
 * при фанауте движок отсеивает адресатов без права видеть `ref` через NotificationRefRegistry.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly i18n: I18nService,
    private readonly events: EventBusService,
    private readonly redis: RedisService,
    private readonly refs: NotificationRefRegistry,
    private readonly renderer: NotificationsRenderer,
    private readonly analytics: AnalyticsService,
  ) {}

  // ============================================================
  // Продюсер
  // ============================================================

  async send(tx: Tx | null, input: SendNotificationInput): Promise<NotificationSendResult | null> {
    const def = notificationDef(input.type);
    if (!def) throw badRequest('notification.unknownType');
    if (!input.to.length) return null;

    if (input.budget === 'workspace' && input.workspaceId) {
      const key = NOTIFICATION_REDIS.budget(input.workspaceId);
      const used = await slidingPeek(this.redis, key, 3600).catch(() => 0);
      if (used >= NOTIFICATION_LIMITS.workspaceBudgetPerHour) throw badRequest('notification.rateLimited');
      await slidingRecord(this.redis, key, 3600).catch(() => undefined);
    }

    const payload = input.payload ?? {};
    // Снимок текста в языке-источнике — фолбэк для типов, ушедших из реестра (как у хроники)
    const snapshot = this.renderer.render(SOURCE_LOCALE, input.type, payload);
    const eventId = randomUUID();
    const client = tx ?? this.db;
    const options = {
      channels: input.channels ?? null,
      includeActor: !!input.includeActor,
      audienceCtx: input.audienceCtx ?? null,
    };

    if (input.idempotencyKey) {
      // Партиальный unique (type, idempotency_key) — INSERT ON CONFLICT DO NOTHING:
      // повтор джоба/ретрай продюсера не рождает второе событие.
      const inserted = await client.$executeRaw`
        INSERT INTO notification_events
          (id, type, service, priority, payload, ref_type, ref_id, actor_id, workspace_id, collapse_key,
           idempotency_key, action_url, reason, recipients, options, snapshot, created_at)
        VALUES
          (${eventId}, ${input.type}, ${def.service}, ${def.priority}, ${JSON.stringify(payload)}::jsonb,
           ${input.ref?.type ?? null}, ${input.ref?.id ?? null}, ${input.actorId ?? null}, ${input.workspaceId ?? null},
           ${input.collapseKey ?? null}, ${input.idempotencyKey}, ${input.actionUrl ?? null}, ${input.reason ?? null},
           ${JSON.stringify(input.to)}::jsonb, ${JSON.stringify(options)}::jsonb, ${JSON.stringify(snapshot)}::jsonb,
           ${utcTs(new Date())})
        ON CONFLICT ("type", "idempotency_key") WHERE "idempotency_key" IS NOT NULL DO NOTHING
      `;
      if (inserted === 0) return null;
    } else {
      await client.notificationEvent.create({
        data: {
          id: eventId,
          type: input.type,
          service: def.service,
          priority: def.priority,
          payload: payload as Prisma.InputJsonValue,
          refType: input.ref?.type ?? null,
          refId: input.ref?.id ?? null,
          actorId: input.actorId ?? null,
          workspaceId: input.workspaceId ?? null,
          collapseKey: input.collapseKey ?? null,
          actionUrl: input.actionUrl ?? null,
          reason: input.reason ?? null,
          recipients: input.to as unknown as Prisma.InputJsonValue,
          options: options as unknown as Prisma.InputJsonValue,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await this.jobs.enqueue(tx, { type: NOTIFICATION_JOBS.fanout, payload: { eventId } });
    return { eventId };
  }

  // ============================================================
  // Лента
  // ============================================================

  async list(userId: string, q: ListNotificationsQuery): Promise<NotificationPageDto> {
    const limit = q.limit ?? NOTIFICATION_LIMITS.pageSize;
    const now = new Date();
    const where: Prisma.NotificationWhereInput = { userId };
    if (q.context === NOTIFICATION_PERSONAL_CONTEXT) where.workspaceId = null;
    else if (q.context) where.workspaceId = q.context;
    if (q.service) where.service = q.service;
    if (q.mentions) where.reason = 'mention';
    switch (q.state ?? 'all') {
      case 'unread':
        where.readAt = null;
        where.archivedAt = null;
        where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }];
        break;
      case 'saved':
        where.savedAt = { not: null };
        break;
      case 'snoozed':
        where.snoozedUntil = { gt: now };
        break;
      case 'archived':
        where.archivedAt = { not: null };
        break;
      default:
        where.archivedAt = null;
        where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }];
    }
    const decoded = decodeCursor(q.cursor);
    const cursorWhere: Prisma.NotificationWhereInput | null = decoded
      ? { OR: [{ sortAt: { lt: decoded.sortAt } }, { sortAt: decoded.sortAt, id: { lt: decoded.id } }] }
      : null;
    const finalWhere: Prisma.NotificationWhereInput = cursorWhere ? { AND: [where, cursorWhere] } : where;

    const rows = await this.db.notification.findMany({
      where: finalWhere,
      orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { event: true },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.sortAt, last.id) : null;

    const actorIds = new Set<string>();
    const wsIds = new Set<string>();
    for (const r of page) {
      for (const a of r.actorIds) actorIds.add(a);
      if (r.event.actorId) actorIds.add(r.event.actorId);
      if (r.workspaceId) wsIds.add(r.workspaceId);
      if (r.event.workspaceId) wsIds.add(r.event.workspaceId);
    }
    const [users, workspaces] = await Promise.all([
      actorIds.size ? this.db.user.findMany({ where: { id: { in: [...actorIds] } }, select: USER_LITE }) : [],
      wsIds.size ? this.db.workspace.findMany({ where: { id: { in: [...wsIds] } }, select: { id: true, name: true, logo: true } }) : [],
    ]);

    const locale = this.i18n.locale;
    const items: NotificationDto[] = page.map((r) => this.toDto(r, locale));
    return {
      items,
      nextCursor,
      actors: users.map((u): NotificationActorDto => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar })),
      workspaces: workspaces.map((w): NotificationWorkspaceDto => ({ id: w.id, name: w.name, logo: w.logo })),
    };
  }

  private toDto(
    r: Prisma.NotificationGetPayload<{ include: { event: true } }>,
    locale: Locale,
  ): NotificationDto {
    const payload = (r.event.payload ?? {}) as Record<string, unknown>;
    const text = this.renderer.render(locale, r.type, payload, {
      collapseCount: r.collapseCount,
      snapshot: (r.event.snapshot as { title?: unknown; body?: unknown } | null) ?? null,
    });
    const ref: NotificationRef | null = r.event.refType && r.event.refId ? { type: r.event.refType, id: r.event.refId } : null;
    const def = notificationDef(r.type);
    return {
      id: r.id,
      type: r.type,
      service: r.service,
      priority: r.priority as NotificationDto['priority'],
      icon: def?.icon ?? 'bell',
      title: text.title,
      body: text.body,
      href: this.hrefFor(r.event.actionUrl, ref, r.workspaceId ?? r.event.workspaceId ?? null),
      ref,
      richCardType: this.richCardTypeFor(ref),
      actorId: r.event.actorId ?? (r.actorIds.length ? r.actorIds[r.actorIds.length - 1] : null),
      actorIds: r.actorIds,
      collapseCount: r.collapseCount,
      workspaceId: r.workspaceId,
      reason: (r.reason as NotificationReason | null) ?? null,
      payload,
      seenAt: r.seenAt?.toISOString() ?? null,
      readAt: r.readAt?.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      savedAt: r.savedAt?.toISOString() ?? null,
      snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      sortAt: r.sortAt.toISOString(),
    };
  }

  /** Deep link: actionUrl продюсера → href(ref) реестра → ничего. Адрес обязан вести на существующую страницу. */
  hrefFor(actionUrl: string | null, ref: NotificationRef | null, workspaceId: string | null): string | null {
    if (actionUrl) return actionUrl;
    if (!ref) return null;
    return this.refs.get(ref.type)?.href(ref, { workspaceId }) ?? null;
  }

  richCardTypeFor(ref: NotificationRef | null): RichCardRefType | null {
    if (!ref) return null;
    const registered = this.refs.get(ref.type)?.richCardType;
    if (registered) return registered;
    return (RICH_CARD_REF_TYPES as readonly string[]).includes(ref.type) ? (ref.type as RichCardRefType) : null;
  }

  async counts(userId: string): Promise<NotificationCountsDto> {
    const now = new Date();
    const rows = await this.db.notification.groupBy({
      by: ['workspaceId'],
      where: { userId, seenAt: null, archivedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] },
      _count: { _all: true },
    });
    const byContext: Record<string, number> = {};
    let unseen = 0;
    for (const r of rows) {
      byContext[r.workspaceId ?? NOTIFICATION_PERSONAL_CONTEXT] = r._count._all;
      unseen += r._count._all;
    }
    return { unseen, byContext };
  }

  // ============================================================
  // Состояния строки (всё скоуплено userId — чужую строку тронуть нельзя)
  // ============================================================

  /** Открыл панель → показанные строки просмотрены (бейдж гаснет, жирность остаётся). */
  async markSeen(userId: string, ids?: string[]): Promise<{ updated: number }> {
    const where: Prisma.NotificationWhereInput = { userId, seenAt: null };
    if (ids?.length) where.id = { in: ids };
    const res = await this.db.notification.updateMany({ where, data: { seenAt: new Date() } });
    if (res.count > 0) this.emitCounts(userId, 'seen');
    return { updated: res.count };
  }

  async markRead(userId: string, input: MarkNotificationsReadInput): Promise<{ updated: number }> {
    const where: Prisma.NotificationWhereInput = { userId, readAt: null };
    if (input.ids?.length) where.id = { in: input.ids };
    else if (input.context === NOTIFICATION_PERSONAL_CONTEXT) where.workspaceId = null;
    else if (input.context) where.workspaceId = input.context;
    const now = new Date();
    // Прочитано ⇒ и просмотрено (seen никогда не позже read)
    const res = await this.db.notification.updateMany({ where, data: { readAt: now } });
    await this.db.notification.updateMany({ where: { ...where, readAt: now, seenAt: null }, data: { seenAt: now } });
    if (res.count > 0) {
      this.emitCounts(userId, 'read');
      await this.analytics.track(null, 'notifications.notification.read', { count: res.count, scope: input.ids?.length ? 'ids' : 'all' }, { userId });
    }
    return { updated: res.count };
  }

  async setState(
    userId: string,
    id: string,
    action: 'read' | 'unread' | 'archive' | 'unarchive' | 'save' | 'unsave' | 'unsnooze',
  ): Promise<NotificationDto> {
    const row = await this.own(userId, id);
    const now = new Date();
    const data: Prisma.NotificationUpdateInput = {};
    switch (action) {
      case 'read':
        data.readAt = row.readAt ?? now;
        data.seenAt = row.seenAt ?? now;
        break;
      case 'unread':
        data.readAt = null;
        break;
      case 'archive':
        data.archivedAt = row.archivedAt ?? now;
        data.seenAt = row.seenAt ?? now;
        data.readAt = row.readAt ?? now;
        break;
      case 'unarchive':
        data.archivedAt = null;
        break;
      case 'save':
        data.savedAt = row.savedAt ?? now;
        break;
      case 'unsave':
        data.savedAt = null;
        break;
      case 'unsnooze':
        data.snoozedUntil = null;
        data.sortAt = now;
        break;
    }
    // Возврат в непрочитанные/неархивные не должен столкнуться с живой строкой того же
    // ключа: пробуждаем под своим уникальным ключом (история остаётся отдельной строкой).
    if ((action === 'unread' || action === 'unarchive') && row.collapseKey !== row.eventId) {
      const clash = await this.db.notification.count({
        where: { userId, collapseKey: row.collapseKey, readAt: null, archivedAt: null, id: { not: id } },
      });
      if (clash > 0) data.collapseKey = row.eventId;
    }
    const updated = await this.db.notification.update({ where: { id }, data, include: { event: true } });
    this.emitCounts(userId, action === 'unsnooze' ? 'unsnoozed' : action === 'archive' || action === 'unarchive' ? 'archived' : 'read');
    return this.toDto(updated, this.i18n.locale);
  }

  async snooze(userId: string, id: string, until: Date): Promise<NotificationDto> {
    const row = await this.own(userId, id);
    const now = Date.now();
    if (until.getTime() <= now) throw badRequest('notification.snooze.inPast');
    if (until.getTime() - now > NOTIFICATION_LIMITS.maxSnoozeDays * 86_400_000) {
      throw badRequest('notification.snooze.tooFar', { days: NOTIFICATION_LIMITS.maxSnoozeDays });
    }
    const updated = await this.db.$transaction(async (tx) => {
      const u = await tx.notification.update({
        where: { id: row.id },
        data: { snoozedUntil: until, seenAt: row.seenAt ?? new Date() },
        include: { event: true },
      });
      // Пробуждение — джобом (runAt = until); новая активность по ключу пробуждает раньше (UPDATE фанаута)
      await this.jobs.enqueue(tx, {
        type: NOTIFICATION_JOBS.unsnooze,
        payload: { notificationId: row.id },
        runAt: until,
        uniqueKey: `snooze:${row.id}`,
      });
      return u;
    });
    this.emitCounts(userId, 'snoozed');
    return this.toDto(updated, this.i18n.locale);
  }

  /** Обработчик джоба пробуждения: строка возвращается наверх и снова непросмотрена. */
  async wakeSnoozed(notificationId: string): Promise<void> {
    const now = new Date();
    const res = await this.db.notification.updateMany({
      where: { id: notificationId, snoozedUntil: { not: null, lte: now } },
      data: { snoozedUntil: null, sortAt: now, seenAt: null },
    });
    if (res.count > 0) {
      const row = await this.db.notification.findUnique({ where: { id: notificationId }, select: { userId: true } });
      if (row) this.emitCounts(row.userId, 'unsnoozed');
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    await this.own(userId, id);
    await this.db.notification.delete({ where: { id } });
    this.emitCounts(userId, 'deleted');
  }

  /**
   * Исключение из организации / выход из неё → её строки у человека архивируются (не
   * удаляются). Стоять обязано на ОБОИХ путях: иначе у вышедшего сам собой остаётся
   * непросматриваемый хвост — чипа этой организации в панели у него уже нет.
   */
  async archiveWorkspaceRows(tx: Tx | null, userId: string, workspaceId: string): Promise<number> {
    const client = tx ?? this.db;
    const now = new Date();
    const res = await client.notification.updateMany({
      where: { userId, workspaceId, archivedAt: null },
      data: { archivedAt: now, seenAt: now, readAt: now },
    });
    if (res.count > 0) this.emitCounts(userId, 'archived');
    return res.count;
  }

  /**
   * Организация удалена (ретеншн архива): `Notification.workspaceId` — колонка без FK,
   * поэтому строки пережили бы её и остались бы «призраком контекста» — в бейдже они
   * есть, а чипа, которым их отфильтровать, уже нет. Архивируем все разом.
   */
  async archiveWorkspaceRowsForAll(tx: Tx | null, workspaceId: string): Promise<number> {
    const client = tx ?? this.db;
    const now = new Date();
    const res = await client.notification.updateMany({
      where: { workspaceId, archivedAt: null },
      data: { archivedAt: now, seenAt: now, readAt: now },
    });
    return res.count;
  }

  private async own(userId: string, id: string) {
    const row = await this.db.notification.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw notFound('notification.notFound');
    return row;
  }

  // ============================================================
  // Mute объекта
  // ============================================================

  async mute(userId: string, refType: string, refId: string): Promise<void> {
    await this.db.notificationSubscription.upsert({
      where: { userId_refType_refId: { userId, refType, refId } },
      update: { mode: 'mute' },
      create: { userId, refType, refId, mode: 'mute' },
    });
  }

  async unmute(userId: string, refType: string, refId: string): Promise<void> {
    await this.db.notificationSubscription.deleteMany({ where: { userId, refType, refId, mode: 'mute' } });
  }

  // ============================================================
  // Dev-наблюдаемость
  // ============================================================

  async devDeliveries(q: { userId?: string; eventId?: string; limit?: number }): Promise<NotificationDeliveryDto[]> {
    const rows = await this.db.notificationDelivery.findMany({
      where: { ...(q.userId ? { userId: q.userId } : {}), ...(q.eventId ? { eventId: q.eventId } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit ?? 50,
    });
    return rows.map((d) => ({
      id: d.id.toString(),
      eventId: d.eventId,
      recipient: d.recipient,
      userId: d.userId,
      channel: d.channel as NotificationChannel,
      notificationId: d.notificationId,
      status: d.status as NotificationDeliveryDto['status'],
      skipReason: (d.skipReason as NotificationDeliveryDto['skipReason']) ?? null,
      providerMessageId: d.providerMessageId,
      error: d.error,
      attempts: d.attempts,
      scheduledAt: d.scheduledAt?.toISOString() ?? null,
      sentAt: d.sentAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /** Сигнал realtime: счётчики человека изменились (at-most-once допустимо). */
  emitCounts(userId: string, reason: NotificationsCountsBusPayload['reason']): void {
    const payload: NotificationsCountsBusPayload = { userId, reason };
    try {
      this.events.emit(NOTIFICATION_BUS_EVENTS.counts, payload, 'notifications');
    } catch (e) {
      this.logger.warn(`counts emit failed: ${(e as Error).message}`);
    }
  }
}

/** Opaque keyset cursor: "<ISO sortAt>_<id>". */
function encodeCursor(sortAt: Date, id: string): string {
  return `${sortAt.toISOString()}_${id}`;
}

function decodeCursor(cursor?: string): { sortAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf('_');
  if (idx === -1) return null;
  const sortAt = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(sortAt.getTime()) || !id) return null;
  return { sortAt, id };
}
