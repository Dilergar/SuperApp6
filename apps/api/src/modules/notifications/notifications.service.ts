import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { JobsService } from '../../core/jobs/jobs.service';
import {
  NOTIFICATION_REGISTRY,
  NOTIFICATION_LIMITS,
  interpolateTemplate,
  type NotificationType,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';
import { MAPPED_EVENT_TYPES, NOTIFY_DISPATCH_JOB } from './notifications.map';

/**
 * Central cross-module notifications service.
 *
 * - `notify(userId, type, payload)` is the single entry-point all modules
 *   should use to create a notification row.
 * - `emitEvent(type, payload, emittedBy)` — точка эмиттеров доменных событий
 *   (Волна 1 движка джобов): событие уходит на шину (для остальных листенеров)
 *   И — для типов из MAPPED_EVENT_TYPES — ставится джоб notifications.dispatch,
 *   который надёжно (at-least-once + dedupKey) создаст строки уведомлений.
 * - Title / body / icon come from NOTIFICATION_REGISTRY in @superapp/shared,
 *   so all three layers (api / web / mobile) agree on presentation.
 * - Push delivery is not yet wired; when it is, `pushByDefault` from the
 *   registry will drive the decision.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private db: DatabaseService,
    private readonly events: EventBusService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Create a notification for a single user. Returns the created row, or null
   * when a `dedupKey` was given and the row already exists (идемпотентность
   * at-least-once джоба: ретрай после частичного фанаута не дублит строки —
   * INSERT ON CONFLICT DO NOTHING, как enqueue движка джобов).
   */
  async notify(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
    options: { actionUrl?: string | null; dedupKey?: string } = {},
  ) {
    const meta = NOTIFICATION_REGISTRY[type];
    if (!meta) {
      throw new Error(`Unknown notification type: ${type}`);
    }

    const title = renderTemplate(meta.title, payload);
    const body = meta.body ? renderTemplate(meta.body, payload) : null;

    if (options.dedupKey) {
      await this.db.$executeRaw`
        INSERT INTO notifications (id, user_id, type, title, body, payload, action_url, dedup_key, created_at)
        VALUES (${randomUUID()}, ${userId}, ${type}, ${title}, ${body}, ${JSON.stringify(payload)}::jsonb, ${options.actionUrl ?? null}, ${options.dedupKey}, now())
        ON CONFLICT ("dedup_key") DO NOTHING
      `;
      return null;
    }

    return this.db.notification.create({
      data: {
        userId,
        type,
        title,
        body,
        payload: payload as Prisma.InputJsonValue,
        actionUrl: options.actionUrl ?? null,
      },
    });
  }

  /**
   * Эмиттер доменного события: шина (сигнал остальным листенерам — плашки,
   * google-sync, подстраховки) + джоб надёжной раскладки уведомлений для
   * маппленных типов. Замена голому events.emit на ~40 сайтах 6 модулей —
   * пара «событие + уведомление» не может разъехаться.
   */
  emitEvent(type: string, payload: Record<string, unknown>, emittedBy: string): void {
    this.events.emit(type, payload, emittedBy);
    if (!MAPPED_EVENT_TYPES.has(type)) return;
    void this.enqueueForEvent(null, type, payload).catch((err) =>
      this.logger.error(
        `enqueue notifications.dispatch for ${type} failed: ${String((err as Error)?.message ?? err)}`,
      ),
    );
  }

  /**
   * Поставить джоб раскладки уведомлений (для точечного in-tx outbox там, где
   * транзакция эмиттера под рукой; emitEvent зовёт с tx=null после коммита).
   */
  async enqueueForEvent(
    tx: Prisma.TransactionClient | null,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!MAPPED_EVENT_TYPES.has(type)) {
      this.logger.warn(`enqueueForEvent: событие "${type}" не в карте уведомлений — джоб не ставлю`);
      return;
    }
    await this.jobs.enqueue(tx, {
      type: NOTIFY_DISPATCH_JOB,
      payload: { event: type, data: payload },
    });
  }

  /** Feed: cursor pagination by createdAt (newest first). */
  async list(userId: string, cursor?: string) {
    const limit = NOTIFICATION_LIMITS.pageSize;

    const where: Prisma.NotificationWhereInput = { userId };
    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Keyset on (createdAt, id): everything strictly "older" than the cursor.
      // Using id as a tiebreaker prevents skipping/duplicating rows that share
      // the same createdAt (EventBus fan-out can create several per millisecond).
      where.OR = [
        { createdAt: { lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { lt: decoded.id } },
      ];
    }

    const [items, unreadCount] = await Promise.all([
      this.db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.notification.count({
        where: { userId, readAt: null },
      }),
    ]);

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return {
      items: page.map((n) => ({
        id: n.id,
        userId: n.userId,
        type: n.type,
        title: n.title,
        body: n.body,
        payload: n.payload,
        actionUrl: n.actionUrl,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
      nextCursor,
    };
  }

  /**
   * Mark notifications as read.
   * If `ids` is undefined or empty → mark ALL unread for this user.
   * Returns the number of rows updated.
   */
  async markRead(userId: string, ids?: string[]) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      readAt: null,
    };
    if (ids && ids.length > 0) {
      where.id = { in: ids };
    }

    const result = await this.db.notification.updateMany({
      where,
      data: { readAt: new Date() },
    });

    return { updated: result.count };
  }

  /** Delete a single notification (only if it belongs to the user). */
  async delete(userId: string, id: string) {
    const notification = await this.db.notification.findUnique({ where: { id } });
    if (!notification || notification.userId !== userId) {
      throw new NotFoundException('Уведомление не найдено');
    }
    await this.db.notification.delete({ where: { id } });
  }

  /**
   * Prune notifications older than the retention window so the table stays
   * bounded. Run by NotificationsCron. Returns the number of rows deleted.
   * Батчами (retention-паттерн Stripe/GitHub): одно deleteMany на миллионы строк —
   * это лавина WAL, долгие локи и лаг реплики; теперь идём по индексу createdAt
   * кусками по 10k.
   */
  async cleanupOld(): Promise<number> {
    const cutoff = new Date(
      Date.now() - NOTIFICATION_LIMITS.retentionDays * 24 * 60 * 60 * 1000,
    );
    const BATCH = 10_000;
    let total = 0;
    for (;;) {
      const rows = await this.db.notification.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const res = await this.db.notification.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      total += res.count;
      if (rows.length < BATCH) break;
    }
    return total;
  }
}

/**
 * `{{placeholder}}` renderer для шаблонов NOTIFICATION_REGISTRY — единый движок
 * подстановки на весь проект (interpolateTemplate из @superapp/shared; тот же
 * используют хроника и «Процессы»). Пропущенный ключ → пустая строка.
 */
function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return interpolateTemplate(template, payload);
}

/** Opaque keyset cursor: "<ISO createdAt>_<id>". Neither part contains '_'. */
function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

function decodeCursor(
  cursor?: string,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf('_');
  if (idx === -1) return null; // malformed → treat as first page
  const createdAt = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}
