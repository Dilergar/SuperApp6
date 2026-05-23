import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import {
  NOTIFICATION_REGISTRY,
  NOTIFICATION_LIMITS,
  type NotificationType,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';

/**
 * Central cross-module notifications service.
 *
 * - `notify(userId, type, payload)` is the single entry-point all modules
 *   (directly or via EventBus) should use to create a notification row.
 * - Title / body / icon come from NOTIFICATION_REGISTRY in @superapp/shared,
 *   so all three layers (api / web / mobile) agree on presentation.
 * - Push delivery is not yet wired; when it is, `pushByDefault` from the
 *   registry will drive the decision.
 */
@Injectable()
export class NotificationsService {
  constructor(private db: DatabaseService) {}

  /** Create a notification for a single user. Returns the created row. */
  async notify(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
    options: { actionUrl?: string | null } = {},
  ) {
    const meta = NOTIFICATION_REGISTRY[type];
    if (!meta) {
      throw new Error(`Unknown notification type: ${type}`);
    }

    const title = renderTemplate(meta.title, payload);
    const body = meta.body ? renderTemplate(meta.body, payload) : null;

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
   */
  async cleanupOld(): Promise<number> {
    const cutoff = new Date(
      Date.now() - NOTIFICATION_LIMITS.retentionDays * 24 * 60 * 60 * 1000,
    );
    const res = await this.db.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return res.count;
  }
}

/**
 * Very small `{{placeholder}}` renderer used against the NOTIFICATION_REGISTRY
 * templates. Missing payload keys are replaced with an empty string so the
 * client never sees a stray `{{...}}` token.
 */
function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = payload[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
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
