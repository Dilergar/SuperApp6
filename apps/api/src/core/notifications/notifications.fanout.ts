import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { Prisma } from '@prisma/client';
import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_PERSONAL_CONTEXT,
  collapseKeyFor,
  notificationDef,
  type AudienceContext,
  type AudienceRef,
  type NotificationChannel,
  type NotificationRef,
  type NotificationSkipReason,
  type NotificationTypeDef,
  type NotificationsCreatedBusPayload, uuidv7 } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { AudiencesService } from '../audiences/audiences.service';
import { LifecyclePartitions } from '../lifecycle/lifecycle.partitions';
import { NOTIFICATION_BUS_EVENTS, NOTIFICATION_JOBS, NOTIFICATION_QUEUE, NOTIFICATION_REDIS } from './notifications.constants';
import { NotificationChannelRegistry, NotificationRefRegistry, PresenceProviderRegistry } from './notifications.registry';
import { NotificationsPreferencesService, decideChannel, smsOptedIn, type PolicyMap, type PrefMap } from './notifications.preferences.service';
import { NotificationsService, type NotificationRecipient } from './notifications.service';
import { quietState } from './notifications.quiet';
import { countInWindow } from './notifications.window';

type Tx = Prisma.TransactionClient;

/** Окно записи чанка фанаута: дефолтных 5 с Prisma на 500 адресатов не хватает (см. deliverToUsers). */
const NOTIFICATION_FANOUT_TX = { timeout: 60_000, maxWait: 15_000 } as const;

interface EventRow {
  id: string;
  type: string;
  service: string;
  priority: string;
  payload: Record<string, unknown>;
  refType: string | null;
  refId: string | null;
  actorId: string | null;
  workspaceId: string | null;
  collapseKey: string | null;
  actionUrl: string | null;
  reason: string | null;
  recipients: NotificationRecipient[];
  options: { channels?: Partial<Record<NotificationChannel, boolean>> | null; includeActor?: boolean; audienceCtx?: Partial<AudienceContext> | null } | null;
  createdAt: Date;
}

interface UserPlan {
  userId: string;
  context: string; // 'personal' | workspaceId
  locale: string;
  timezone: string;
  phone: string;
  inapp: { on: boolean; skip: NotificationSkipReason | null };
  push: { on: boolean; skip: NotificationSkipReason | null; runAt: Date | null };
  sms: { on: boolean; skip: NotificationSkipReason | null };
  email: { on: boolean; skip: NotificationSkipReason | null };
}

/**
 * Джоб `notifications.fanout` (очередь `notifications`, идемпотентен): разворот адресатов →
 * отсев без права видеть объект (батчем) → контекст строки по членству → эффективные
 * каналы на каждого → в ОДНОЙ tx на чанк: леджер доставки (ON CONFLICT DO NOTHING на
 * канале inapp = адресат уже обработан) → схлопывание/вставка строки ленты → строки
 * доставки прочих каналов (в т.ч. skipped с причиной) → канальные джобы → после
 * коммита сигнал realtime. Ретрай после падения на 3-м адресате из 5 не дублирует и не
 * накручивает счётчик — благодаря леджеру, а не unique на строке ленты.
 */
@Injectable()
export class NotificationsFanout implements OnModuleInit {
  private readonly logger = new Logger(NotificationsFanout.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly events: EventBusService,
    private readonly redis: RedisService,
    private readonly audiences: AudiencesService,
    private readonly refs: NotificationRefRegistry,
    private readonly presence: PresenceProviderRegistry,
    private readonly channels: NotificationChannelRegistry,
    private readonly prefs: NotificationsPreferencesService,
    private readonly notifications: NotificationsService,
    private readonly partitions: LifecyclePartitions,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(NOTIFICATION_JOBS.fanout, (payload) => this.fanout(String(payload['eventId'] ?? '')), {
      queue: NOTIFICATION_QUEUE,
      queueConcurrency: 4,
      maxAttempts: 8,
    });
    this.jobsRegistry.register(
      NOTIFICATION_JOBS.fanoutChunk,
      (payload) =>
        this.fanoutChunk(
          String(payload['eventId'] ?? ''),
          Array.isArray(payload['userIds']) ? (payload['userIds'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
        ),
      { queue: NOTIFICATION_QUEUE, queueConcurrency: 4, maxAttempts: 8 },
    );
    this.jobsRegistry.register(
      NOTIFICATION_JOBS.unsnooze,
      (payload) => this.notifications.wakeSnoozed(String(payload['notificationId'] ?? '')),
      { queue: NOTIFICATION_QUEUE },
    );
  }

  // ============================================================
  // Разворот адресатов
  // ============================================================

  private async loadEvent(eventId: string): Promise<EventRow> {
    const ev = await this.db.notificationEvent.findUnique({ where: { id: eventId } });
    // Событие исчезло (ретеншн/удаление) — работа потеряла смысл: постоянная ошибка
    if (!ev) throw new JobDiscardError(`event ${eventId} not found`);
    return {
      id: ev.id,
      type: ev.type,
      service: ev.service,
      priority: ev.priority,
      payload: (ev.payload ?? {}) as Record<string, unknown>,
      refType: ev.refType,
      refId: ev.refId,
      actorId: ev.actorId,
      workspaceId: ev.workspaceId,
      collapseKey: ev.collapseKey,
      actionUrl: ev.actionUrl,
      reason: ev.reason,
      recipients: Array.isArray(ev.recipients) ? (ev.recipients as unknown as NotificationRecipient[]) : [],
      options: (ev.options as EventRow['options']) ?? null,
      createdAt: ev.createdAt,
    };
  }

  private async fanout(eventId: string): Promise<void> {
    const ev = await this.loadEvent(eventId);
    const def = notificationDef(ev.type);
    if (!def) {
      this.logger.warn(`[${eventId}] type "${ev.type}" is not in the registry; fanout skipped`);
      return;
    }

    const userIds = new Set<string>();
    const chatIds = new Set<string>();
    const audienceRefs: AudienceRef[] = [];
    for (const r of ev.recipients) {
      if ('userId' in r && typeof r.userId === 'string') userIds.add(r.userId);
      else if ('chatId' in r && typeof r.chatId === 'string') chatIds.add(r.chatId);
      else if ('type' in r && 'id' in r) audienceRefs.push(r as AudienceRef);
    }
    if (audienceRefs.length) {
      const ctx: AudienceContext = {
        workspaceId: ev.options?.audienceCtx?.workspaceId ?? ev.workspaceId ?? null,
        initiatorId: ev.options?.audienceCtx?.initiatorId ?? ev.actorId ?? null,
        subjectId: ev.options?.audienceCtx?.subjectId ?? null,
        selfId: ev.options?.audienceCtx?.selfId ?? null,
        branchId: ev.options?.audienceCtx?.branchId ?? null,
      };
      try {
        const resolved = await this.audiences.resolve(audienceRefs, ctx, {
          max: NOTIFICATION_LIMITS.maxRecipients,
          onOverflow: 'truncate',
        });
        for (const id of resolved) userIds.add(id);
      } catch (e) {
        // Якорь без контекста / чужой вид — постоянная ошибка адресации, ретраить нечего
        this.logger.warn(`[${eventId}] recipients did not resolve: ${(e as Error).message}`);
      }
    }
    // Подписчики follow на объект — авто-адресаты (Odoo followers / Knock Objects)
    if (ev.refType && ev.refId) {
      const followers = await this.db.notificationSubscription.findMany({
        where: { refType: ev.refType, refId: ev.refId, mode: 'follow' },
        select: { userId: true },
      });
      for (const f of followers) userIds.add(f.userId);
    }
    if (ev.actorId && !ev.options?.includeActor) userIds.delete(ev.actorId);

    // Объекты-получатели канала chat — своя ветка доставки, без строк ленты
    if (chatIds.size) await this.queueChatDeliveries(ev, [...chatIds]);

    const ids = [...userIds];
    if (!ids.length) return;
    if (ids.length > NOTIFICATION_LIMITS.fanoutChunk) {
      // Массовый фанаут — дочерними чанками (леджер дедупит повтор при ретрае родителя)
      for (let i = 0; i < ids.length; i += NOTIFICATION_LIMITS.fanoutChunk) {
        await this.jobs.enqueue(null, {
          type: NOTIFICATION_JOBS.fanoutChunk,
          payload: { eventId, userIds: ids.slice(i, i + NOTIFICATION_LIMITS.fanoutChunk) },
          uniqueKey: `fanout:${eventId}:${i}`,
        });
      }
      return;
    }
    await this.deliverToUsers(ev, def, ids);
  }

  private async fanoutChunk(eventId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const ev = await this.loadEvent(eventId);
    const def = notificationDef(ev.type);
    if (!def) return;
    await this.deliverToUsers(ev, def, userIds);
  }

  // ============================================================
  // Эффективные каналы на адресата и запись
  // ============================================================

  private async deliverToUsers(ev: EventRow, def: NotificationTypeDef, candidateIds: string[]): Promise<void> {
    const eventId = ev.id;
    const ref: NotificationRef | null = ev.refType && ev.refId ? { type: ev.refType, id: ev.refId } : null;

    // 1) Отсев без права видеть объект — батчем через резолвер владельца (Jira-правило)
    const noAccess = new Set<string>();
    if (ref) {
      const resolver = this.refs.get(ref.type);
      if (resolver) {
        try {
          const allowed = new Set(await resolver.canViewMany(candidateIds, ref.id));
          for (const id of candidateIds) if (!allowed.has(id)) noAccess.add(id);
        } catch (e) {
          // Резолвер упал (объект удалён после фанаута?) — честнее не слать никому, чем всем
          this.logger.warn(`[${eventId}] canViewMany(${ref.type}) failed: ${(e as Error).message}`);
          throw e;
        }
      }
    }

    // 2) Батч-контекст: люди, членство, настройки, предпочтения, политика, mute, устройства, presence
    const wsId = ev.workspaceId;
    const [users, members, settingsRows, prefMaps, policy, mutes, devices, online] = await Promise.all([
      this.db.user.findMany({ where: { id: { in: candidateIds } }, select: { id: true, locale: true, timezone: true, phone: true } }),
      wsId
        ? this.db.userRole.findMany({
            where: { userId: { in: candidateIds }, context: 'workspace', tenantId: wsId, isActive: true },
            select: { userId: true },
          })
        : Promise.resolve([] as { userId: string }[]),
      this.db.userNotificationSettings.findMany({ where: { userId: { in: candidateIds } } }),
      this.prefs.loadPrefs(candidateIds, wsId ? [NOTIFICATION_PERSONAL_CONTEXT, wsId] : [NOTIFICATION_PERSONAL_CONTEXT], ev.type, def.service),
      this.prefs.loadPolicy(wsId, ev.type, def.service),
      ref
        ? this.db.notificationSubscription.findMany({
            where: { userId: { in: candidateIds }, refType: ref.type, refId: ref.id, mode: 'mute' },
            select: { userId: true },
          })
        : Promise.resolve([] as { userId: string }[]),
      this.db.notificationDevice.findMany({ where: { userId: { in: candidateIds }, disabledAt: null }, select: { userId: true } }),
      def.priority === 'critical' ? Promise.resolve(new Set<string>()) : this.presence.onlineOf(candidateIds),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const memberSet = new Set(members.map((m) => m.userId));
    const settingsById = new Map(settingsRows.map((s) => [s.userId, s]));
    const muted = new Set(mutes.map((m) => m.userId));
    const hasDevice = new Set(devices.map((d) => d.userId));
    const now = new Date();
    const channelOverride = ev.options?.channels ?? null;
    const isMention = ev.reason === 'mention';

    const plans: UserPlan[] = [];
    const skippedNoAccess: string[] = [];
    for (const userId of candidateIds) {
      const user = userById.get(userId);
      if (!user) continue; // удалён между событием и фанаутом
      if (noAccess.has(userId)) {
        skippedNoAccess.push(userId);
        continue;
      }
      const context = wsId && memberSet.has(userId) ? wsId : NOTIFICATION_PERSONAL_CONTEXT;
      const prefs: PrefMap = prefMaps.get(`${userId}|${context}`) ?? new Map();
      const pol: PolicyMap = context === NOTIFICATION_PERSONAL_CONTEXT ? new Map() : policy;
      const plan: UserPlan = {
        userId,
        context,
        locale: user.locale,
        timezone: user.timezone,
        phone: user.phone,
        inapp: { on: true, skip: null },
        push: { on: false, skip: null, runAt: null },
        sms: { on: false, skip: null },
        email: { on: false, skip: 'driver_not_configured' },
      };

      const critical = def.priority === 'critical';
      const mutedHere = muted.has(userId) && !isMention && !critical;

      // in-app
      if (mutedHere) plan.inapp = { on: false, skip: 'muted' };
      else if (channelOverride && channelOverride.inapp === false) plan.inapp = { on: false, skip: 'pref_off' };
      else {
        const d = decideChannel(def, ev.type, 'inapp', prefs, pol);
        plan.inapp = { on: d.enabled, skip: d.enabled ? null : d.reason };
      }

      // push
      if (mutedHere) plan.push = { on: false, skip: 'muted', runAt: null };
      else if (channelOverride && channelOverride.push === false) plan.push = { on: false, skip: 'pref_off', runAt: null };
      else {
        const d = channelOverride?.push === true ? { enabled: true, reason: null } : decideChannel(def, ev.type, 'push', prefs, pol);
        if (!d.enabled) plan.push = { on: false, skip: d.reason, runAt: null };
        else if (!hasDevice.has(userId)) plan.push = { on: false, skip: 'no_device', runAt: null };
        else if (!this.channels.pushLive) plan.push = { on: false, skip: 'driver_not_configured', runAt: null };
        else {
          let runAt = now;
          if (!critical) {
            const quiet = quietState(settingsById.get(userId), now, user.timezone);
            if (quiet.quiet && quiet.until) runAt = quiet.until;
            else if (online.has(userId)) runAt = new Date(now.getTime() + NOTIFICATION_LIMITS.presenceDelayMs);
          }
          plan.push = { on: true, skip: null, runAt };
        }
      }

      // sms — только critical + smsEligible + opt-in (контекст строки); тишина SMS не задерживает у critical
      if (critical && def.smsEligible && smsOptedIn(def, ev.type, prefs)) {
        plan.sms = { on: true, skip: null };
      } else if (critical && def.smsEligible) {
        plan.sms = { on: false, skip: 'pref_off' };
      }

      plans.push(plan);
    }

    // 3) Троттлинг типа на пару (адресат, collapseKey) — Redis, best-effort
    const contextKeyOf = (p: UserPlan) => p.context;
    const collapseKeys = new Map<string, string>();
    for (const p of plans) {
      collapseKeys.set(
        p.userId,
        ev.collapseKey ??
          collapseKeyFor({ type: ev.type, collapse: def.collapse, eventId, ref, actorId: ev.actorId, contextKey: contextKeyOf(p) }),
      );
    }
    if (def.throttle) {
      for (const p of plans) {
        if (!p.inapp.on) continue;
        const n = await countInWindow(this.redis, NOTIFICATION_REDIS.throttle(p.userId, collapseKeys.get(p.userId)!), def.throttle.windowSec).catch(() => 0);
        if (n > def.throttle.max) {
          p.inapp = { on: false, skip: 'throttled' };
          p.push = { on: false, skip: 'throttled', runAt: null };
        }
      }
    }

    // 4) Запись — одной транзакцией на чанк
    const created: NotificationsCreatedBusPayload['recipients'] = [];
    const pushJobs = new Map<string, Date>();
    const smsDeliveryIds: bigint[] = [];
    const nowTs = new Date();

    // Чанк — до `fanoutChunk` адресатов, и на каждого приходится несколько операторов
    // (леджер, строка, доставки прочих каналов). Дефолтные 5 с интерактивной транзакции
    // Prisma такой чанк на нагруженной БД не проходит: P2028 «Transaction already closed»
    // сжёг бы все попытки джоба, и массовая рассылка не дошла бы НИ ДО КОГО. Транзакция
    // только вставляет (конкуренции за строки нет) — держать её дольше безопасно.
    await this.withDeliveryPartition(ev.createdAt, () => this.db.$transaction(async (tx) => {
      // Повтор после заведения партиции: накопленное прошлой попыткой откатилось вместе с ней
      created.length = 0;
      pushJobs.clear();
      smsDeliveryIds.length = 0;
      for (const userId of skippedNoAccess) {
        await this.insertDelivery(tx, ev, userId, 'inapp', 'skipped', 'no_access', null, null);
      }
      for (const p of plans) {
        // Леджер: не легло → адресат уже обработан (ретрай после частичного фанаута)
        const ledger = await this.insertDelivery(tx, ev, p.userId, 'inapp', p.inapp.on ? 'sent' : 'skipped', p.inapp.skip, null, null);
        if (ledger === null) continue;

        if (p.inapp.on) {
          const row = await this.upsertRow(tx, ev, def, p, collapseKeys.get(p.userId)!, nowTs);
          await tx.$executeRaw`UPDATE notification_deliveries SET notification_id = ${row.id}::uuid WHERE id = ${ledger} AND created_at = ${utcTs(ev.createdAt)}`;
          created.push({ userId: p.userId, notificationId: row.id, context: p.context, unseen: true });
          if (p.push.on) {
            const id = await this.insertDelivery(tx, ev, p.userId, 'push', 'queued', null, row.id, p.push.runAt);
            if (id !== null) {
              const prev = pushJobs.get(p.userId);
              if (!prev || (p.push.runAt && p.push.runAt < prev)) pushJobs.set(p.userId, p.push.runAt ?? nowTs);
            }
          } else {
            await this.insertDelivery(tx, ev, p.userId, 'push', 'skipped', p.push.skip, row.id, null);
          }
          if (p.sms.on) {
            const id = await this.insertDelivery(tx, ev, p.userId, 'sms', 'queued', null, row.id, nowTs);
            if (id !== null) smsDeliveryIds.push(id);
          } else if (p.sms.skip) {
            await this.insertDelivery(tx, ev, p.userId, 'sms', 'skipped', p.sms.skip, row.id, null);
          }
          await this.insertDelivery(tx, ev, p.userId, 'email', 'skipped', 'driver_not_configured', row.id, null);
        } else {
          // In-app выключен = строка НЕ создаётся, и остальные каналы молчат (канальная семантика Knock)
          await this.insertDelivery(tx, ev, p.userId, 'push', 'skipped', p.push.skip ?? p.inapp.skip, null, null);
        }
      }
      for (const [userId, runAt] of pushJobs) {
        const critical = def.priority === 'critical';
        await this.enqueuePushJob(tx, userId, runAt, critical);
      }
      for (const id of smsDeliveryIds) {
        await this.jobs.enqueue(tx, { type: NOTIFICATION_JOBS.deliverSms, payload: { deliveryId: id.toString(), at: ev.createdAt.toISOString() } });
      }
    }, NOTIFICATION_FANOUT_TX));

    // 5) После коммита — сигнал realtime (потеря допустима: клиент перечитывает counts на reconnect)
    if (created.length) {
      const payload: NotificationsCreatedBusPayload = { eventId, type: ev.type, recipients: created };
      try {
        this.events.emit(NOTIFICATION_BUS_EVENTS.created, payload, 'notifications');
      } catch (e) {
        this.logger.warn(`[${eventId}] realtime emit failed: ${(e as Error).message}`);
      }
    }
    this.logger.log(`[${eventId}] ${ev.type}: ${created.length} rows, ${pushJobs.size} push, ${smsDeliveryIds.length} sms, ${skippedNoAccess.length} no access`);
  }

  /**
   * Батчер push: один живой джоб на человека (`uniqueKey push:<userId>`), runAt = самое
   * раннее из созревших. Когда джоб уже идёт (inserted=false), ставим ПАРНЫЙ догоняющий
   * (`push:<userId>:next`) — «уже идёт» ≠ «уже учтено» (правило core/jobs). Critical —
   * своим ключом и сразу: ждать конца тишины или +2 мин ему нельзя.
   */
  async enqueuePushJob(tx: Tx | null, userId: string, runAt: Date, critical: boolean): Promise<void> {
    const key = critical ? `push:${userId}:critical` : `push:${userId}`;
    const res = await this.jobs.enqueue(tx, { type: NOTIFICATION_JOBS.deliverPush, payload: { userId }, runAt, uniqueKey: key });
    if (!res.inserted && !critical) {
      await this.jobs.enqueue(tx, {
        type: NOTIFICATION_JOBS.deliverPush,
        payload: { userId },
        runAt: new Date(Math.max(runAt.getTime(), Date.now() + 15_000)),
        uniqueKey: `push:${userId}:next`,
      });
    }
  }

  /**
   * INSERT леджера/журнала доставки. null — уже есть (ретрай). `created_at` = момент СОБЫТИЯ:
   * он детерминирован, поэтому уникум (событие, получатель, канал, created_at) месячной
   * партиции остаётся единственным и на ретрае в другом месяце.
   */
  private async insertDelivery(
    tx: Tx,
    ev: EventRow,
    userId: string,
    channel: NotificationChannel,
    status: 'queued' | 'sent' | 'skipped',
    skipReason: NotificationSkipReason | null,
    notificationId: string | null,
    scheduledAt: Date | null,
  ): Promise<bigint | null> {
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      INSERT INTO notification_deliveries (event_id, recipient, user_id, channel, notification_id, status, skip_reason, scheduled_at, sent_at, created_at)
      VALUES (${ev.id}::uuid, ${`user:${userId}`}, ${userId}::uuid, ${channel}, ${notificationId}::uuid, ${status}, ${skipReason},
              ${scheduledAt ? utcTs(scheduledAt) : null}, ${status === 'sent' ? utcTs(new Date()) : null}, ${utcTs(ev.createdAt)})
      ON CONFLICT (event_id, recipient, channel, created_at) DO NOTHING
      RETURNING id
    `;
    return rows.length ? rows[0].id : null;
  }

  /**
   * Схлопывание при записи одним оператором (race-safe через партиальный unique):
   * живая строка того же ключа обновляется (count++, actorIds ∪, событие — последнее,
   * sortAt наверх, snooze снят, seen сброшен — бейдж зажигается снова); иначе — новая.
   */
  private async upsertRow(tx: Tx, ev: EventRow, def: NotificationTypeDef, p: UserPlan, collapseKey: string, now: Date): Promise<{ id: string; collapseCount: number }> {
    const id = uuidv7();
    const workspaceId = p.context === NOTIFICATION_PERSONAL_CONTEXT ? null : p.context;
    const actorArr = ev.actorId ? [ev.actorId] : [];
    const rows = await tx.$queryRaw<{ id: string; collapse_count: number }[]>`
      INSERT INTO notifications (id, event_id, user_id, workspace_id, type, service, priority, reason, collapse_key, collapse_count, actor_ids,
                                 seen_at, read_at, archived_at, saved_at, snoozed_until, sort_at, created_at, updated_at)
      VALUES (${id}::uuid, ${ev.id}::uuid, ${p.userId}::uuid, ${workspaceId}::uuid, ${ev.type}, ${def.service}, ${def.priority}, ${ev.reason}, ${collapseKey}, 1, ${actorArr}::uuid[],
              NULL, NULL, NULL, NULL, NULL, ${utcTs(now)}, ${utcTs(ev.createdAt)}, ${utcTs(now)})
      ON CONFLICT (user_id, collapse_key) WHERE read_at IS NULL AND archived_at IS NULL
      DO UPDATE SET
        event_id = EXCLUDED.event_id,
        collapse_count = notifications.collapse_count + 1,
        actor_ids = CASE
          WHEN ${ev.actorId}::uuid IS NULL OR ${ev.actorId}::uuid = ANY(notifications.actor_ids) THEN notifications.actor_ids
          ELSE array_append(notifications.actor_ids, ${ev.actorId}::uuid)
        END,
        reason = COALESCE(EXCLUDED.reason, notifications.reason),
        priority = EXCLUDED.priority,
        seen_at = NULL,
        snoozed_until = NULL,
        sort_at = EXCLUDED.sort_at,
        updated_at = EXCLUDED.updated_at
      RETURNING id, collapse_count
    `;
    return { id: rows[0].id, collapseCount: rows[0].collapse_count };
  }

  /** Объекты-получатели chat: строка доставки + джоб; драйвер регистрирует мессенджер. */
  private async queueChatDeliveries(ev: EventRow, chatIds: string[]): Promise<void> {
    const live = !!this.channels.chat();
    const ids: bigint[] = [];
    await this.withDeliveryPartition(ev.createdAt, () => this.db.$transaction(async (tx) => {
      ids.length = 0;
      for (const chatId of chatIds) {
        const rows = await tx.$queryRaw<{ id: bigint }[]>`
          INSERT INTO notification_deliveries (event_id, recipient, user_id, channel, status, skip_reason, scheduled_at, created_at)
          VALUES (${ev.id}::uuid, ${`chat:${chatId}`}, NULL, 'chat', ${live ? 'queued' : 'skipped'}, ${live ? null : 'driver_not_configured'}, ${utcTs(new Date())}, ${utcTs(ev.createdAt)})
          ON CONFLICT (event_id, recipient, channel, created_at) DO NOTHING
          RETURNING id
        `;
        if (rows.length && live) ids.push(rows[0].id);
      }
      for (const id of ids) {
        await this.jobs.enqueue(tx, { type: NOTIFICATION_JOBS.deliverChat, payload: { deliveryId: id.toString(), at: ev.createdAt.toISOString() } });
      }
    }, NOTIFICATION_FANOUT_TX));
  }

  /**
   * Журнал доставок партиционирован по месяцу момента события: месяц без партиции (ночной
   * крон не успел, событие на стыке месяцев) — завести функцией владельца и повторить один раз.
   */
  private async withDeliveryPartition<T>(at: Date, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!LifecyclePartitions.isMissingPartition(err)) throw err;
      await this.partitions.ensureFor('public.notification_deliveries', at);
      return run();
    }
  }
}
