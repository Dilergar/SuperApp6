import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, type LifecyclePurgeBatchContext } from '../lifecycle/lifecycle.purge.registry';

/** Курсор шага: (createdAt, id) последней рассмотренной строки. */
const ROW_CURSOR = { c: 'date', i: 'uuid' } as const;

/**
 * Шаги раннера сроков core/lifecycle для уведомлений (политики `Notification` и
 * `NotificationEvent` реестра; срок — там же, 90 дней):
 *  - строки ленты: Saved живут вечно, отложенные в будущее (snooze) не трогаются;
 *  - события: только те, у которых не осталось ни одной строки адресата.
 * Журнал доставки (`notification_deliveries`) уходит сбросом месячной партиции, строки
 * организации в каскаде её удаления — общей пачкой по `workspaceId`.
 */
@Injectable()
export class NotificationsLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly db: DatabaseService,
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
