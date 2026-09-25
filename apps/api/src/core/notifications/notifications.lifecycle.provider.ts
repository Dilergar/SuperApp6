import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor } from '@superapp/shared';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
  type LifecyclePurgeBatchContext,
} from '../lifecycle/lifecycle.purge.registry';
import { NotificationsService } from './notifications.service';

/** Курсор шага: (createdAt, id) последней рассмотренной строки. */
const ROW_CURSOR = { c: 'date', i: 'uuid' } as const;

/**
 * Шаги раннера сроков core/lifecycle для уведомлений (политики `Notification` и
 * `NotificationEvent` реестра; срок — там же, 90 дней):
 *  - строки ленты: Saved живут вечно, отложенные в будущее (snooze) не трогаются;
 *  - события: только те, у которых не осталось ни одной строки адресата.
 * Журнал доставки (`notification_deliveries`) уходит сбросом месячной партиции, строки
 * организации в каскаде её удаления — общей пачкой по `workspaceId`.
 *
 * Стирание человека (`notifications.subject`, политика `NotificationEvent`): событие остаётся
 * у адресатов, снимок текста, собранный из его данных, снимается (`snapshot` = NULL) — лента
 * рисует событие без снимка. Строки его собственной ленты, настройки и устройства уходят
 * общими шагами оркестратора по `userId`. Хранитель под заморозкой — снимок улика: шаг ждёт.
 */
@Injectable()
export class NotificationsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly notifications: NotificationsService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register('notifications.rows', {
      purgeBatch: (ctx) => this.rowsBatch(ctx),
      estimate: ({ cutoff }) => (cutoff ? this.db.notification.count({ where: this.rowsWhere(cutoff, new Date()) }) : Promise.resolve(0)),
    });
    this.handlers.register('notifications.events', {
      purgeBatch: (ctx) => this.eventsBatch(ctx),
      estimate: ({ cutoff }) => (cutoff ? this.db.notificationEvent.count({ where: { createdAt: { lt: cutoff }, notifications: { none: {} } } }) : Promise.resolve(0)),
    });
    this.subjectHooks.register('notifications.subject', {
      erase: async (userId, ctx) => {
        if (ctx.subjectHeld) {
          ctx.held(1);
          return { rows: 0 };
        }
        return { rows: await this.notifications.redactActorSnapshots(userId) };
      },
    });
    this.canary.register('notifications.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки (строки без доставки: `send` не зовётся): событие, где человек — актор, со
   * снимком его имени — остаётся соседу без снимка; строка ленты соседа — остаётся; своя лента,
   * настройки, подписка, устройство (выключенное) — исчезают.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const base = { type: 'task.assigned', service: 'tasks', priority: 'high' } as const;
    const byHim = await this.db.notificationEvent.create({
      data: { ...base, actorId: ctx.userId, refType: 'task', refId: randomUUID(), recipients: [ctx.peerId], snapshot: { actorName: `Canary ${ctx.name}`, title: ctx.marker }, payload: { canary: true } },
      select: { id: true },
    });
    const peerRow = await this.db.notification.create({ data: { ...base, eventId: byHim.id, userId: ctx.peerId, collapseKey: `canary:${byHim.id}`, actorIds: [ctx.userId] }, select: { id: true } });
    const toHim = await this.db.notificationEvent.create({ data: { ...base, actorId: ctx.peerId, recipients: [ctx.userId], snapshot: { title: ctx.marker } }, select: { id: true } });
    // Событие соседа О человеке: имя парой с id в payload и в собранном снимке
    const aboutHim = await this.db.notificationEvent.create({
      data: { ...base, actorId: ctx.peerId, recipients: [ctx.peerId], payload: { targetUserId: ctx.userId, targetName: `Canary ${ctx.name}` }, snapshot: { title: `Canary ${ctx.name}` } },
      select: { id: true },
    });
    const hisRow = await this.db.notification.create({ data: { ...base, eventId: toHim.id, userId: ctx.userId, collapseKey: `canary:${toHim.id}` }, select: { id: true } });
    const pref = await this.db.notificationPreference.create({ data: { userId: ctx.userId, context: 'personal', subjectKind: 'type', subjectKey: 'task.assigned', channel: 'push', enabled: false }, select: { id: true } });
    const sub = await this.db.notificationSubscription.create({ data: { userId: ctx.userId, refType: 'task', refId: randomUUID(), mode: 'all' }, select: { id: true } });
    const device = await this.db.notificationDevice.create({
      data: { userId: ctx.userId, platform: 'web', provider: 'webpush', token: `canary:${randomUUID()}`, userAgent: ctx.marker, disabledAt: new Date() },
      select: { id: true },
    });
    await this.db.userNotificationSettings.create({ data: { userId: ctx.userId, pausedUntil: new Date(Date.now() + 3_600_000) } });
    return [
      { policy: 'NotificationEvent', id: byHim.id, expect: 'kept' },
      { policy: 'NotificationEvent', id: aboutHim.id, expect: 'kept' },
      { policy: 'Notification', id: peerRow.id, expect: 'kept' },
      { policy: 'Notification', id: hisRow.id, expect: 'gone' },
      { policy: 'NotificationPreference', id: pref.id, expect: 'gone' },
      { policy: 'NotificationSubscription', id: sub.id, expect: 'gone' },
      { policy: 'NotificationDevice', id: device.id, expect: 'gone' },
      { policy: 'UserNotificationSettings', id: ctx.userId, expect: 'gone' },
    ];
  }

  private rowsWhere(cutoff: Date, now: Date): Prisma.NotificationWhereInput {
    return { createdAt: { lt: cutoff }, savedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] };
  }

  private after(cursor: string | null): Prisma.NotificationWhereInput | null {
    const c = decodeCursor(cursor, ROW_CURSOR);
    return c ? { OR: [{ createdAt: { gt: c.c } }, { createdAt: c.c, id: { gt: c.i } }] } : null;
  }

  private async rowsBatch({ cutoff, limit, cursor, releasable }: LifecyclePurgeBatchContext) {
    if (!cutoff) return { rows: 0, more: false };
    const after = this.after(cursor);
    const candidates = await this.db.notification.findMany({
      where: { AND: [this.rowsWhere(cutoff, new Date()), ...(after ? [after] : [])] },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    if (!candidates.length) return { rows: 0, more: false, cursor: null };
    const rows = await this.db.$transaction(async (tx) => {
      const ok = await releasable(tx, candidates.map((c) => c.id));
      if (!ok.length) return 0;
      // Условие повторено: строку могли сохранить (Saved) между выборкой и удалением
      const res = await tx.notification.deleteMany({ where: { id: { in: ok }, savedAt: null } });
      return res.count;
    });
    const last = candidates[candidates.length - 1]!;
    return { rows, more: candidates.length === limit, cursor: encodeCursor({ c: last.createdAt, i: last.id }) };
  }

  private async eventsBatch({ cutoff, limit, cursor, releasable }: LifecyclePurgeBatchContext) {
    if (!cutoff) return { rows: 0, more: false };
    const c = decodeCursor(cursor, ROW_CURSOR);
    const candidates = await this.db.notificationEvent.findMany({
      where: {
        createdAt: { lt: cutoff },
        notifications: { none: {} },
        ...(c ? { OR: [{ createdAt: { gt: c.c } }, { createdAt: c.c, id: { gt: c.i } }] } : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    if (!candidates.length) return { rows: 0, more: false, cursor: null };
    const rows = await this.db.$transaction(async (tx) => {
      const ok = await releasable(tx, candidates.map((e) => e.id));
      if (!ok.length) return 0;
      // Строка адресата могла появиться (схлопывание в то же событие) — удаляем только пустые
      const res = await tx.notificationEvent.deleteMany({ where: { id: { in: ok }, notifications: { none: {} } } });
      return res.count;
    });
    const last = candidates[candidates.length - 1]!;
    return { rows, more: candidates.length === limit, cursor: encodeCursor({ c: last.createdAt, i: last.id }) };
  }
}
