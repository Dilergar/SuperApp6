import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService } from '../../core/access/access.service';
import { fullName } from '../../shared/utils/user-name';
import {
  parseMentions,
  MENTION_LIMITS,
  type MentionItem,
  type MentionFeed,
  type MentionCandidate,
  type MentionSourceType,
} from '@superapp/shared';

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

/**
 * Mentions Hub (Phase 5). Records every @mention of a user and serves a unified
 * feed of them. This phase only PRODUCES messenger mentions (sourceType='messenger');
 * the feed/markRead/candidate APIs are source-agnostic so task/calendar mentions can be
 * added later without touching the hub.
 *
 * Recording is BEST-EFFORT: a failure here must never break sendMessage/editMessage,
 * so every public recorder is wrapped in try/catch + Logger.warn.
 *
 * Idempotency / "new vs already recorded": a @@unique([messageId, mentionedUserId])
 * means a re-edit of the same message never duplicates a row. We detect which mentions
 * are NEW by querying the existing Mention rows for (messageId, in candidateUserIds)
 * BEFORE writing — only the set difference is created, and only that difference is
 * notified. So editing a message to add a new @mention notifies the newly-named person
 * but does NOT re-notify people who were already mentioned in a prior version.
 */
@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);

  constructor(
    private db: DatabaseService,
    private notifications: NotificationsService,
    private access: AccessService,
  ) {}

  /**
   * Parse @mentions out of a freshly-persisted message, security-filter them to current
   * chat members, record the new ones, and notify only the newly-recorded people.
   * Never throws.
   */
  async recordMessageMentions(opts: {
    content: string | null | undefined;
    chatId: string;
    messageId: string;
    authorId: string;
    chatType: string;
  }): Promise<void> {
    const { content, chatId, messageId, authorId } = opts;
    try {
      if (!content) return;
      const parsed = parseMentions(content);
      if (parsed.length === 0) return;

      // Candidate user ids (drop the author — no self-mention).
      const candidateIds = [
        ...new Set(parsed.map((p) => p.userId).filter((id) => id && id !== authorId)),
      ];
      if (candidateIds.length === 0) return;

      // Security filter: keep only CURRENT active members of this chat. A user can't
      // be mentioned (and notified) into a chat they're not in — the token text is
      // attacker-controlled, the membership table is not.
      const members = await this.db.chatMember.findMany({
        where: { chatId, userId: { in: candidateIds }, leftAt: null },
        select: { userId: true },
      });
      const keptIds = members.map((m) => m.userId);
      if (keptIds.length === 0) return;

      // New vs already-recorded: rows already present for THIS message (from a prior
      // edit) must not be re-notified. Compute the difference and create only that.
      const existing = await this.db.mention.findMany({
        where: { messageId, mentionedUserId: { in: keptIds } },
        select: { mentionedUserId: true },
      });
      const existingIds = new Set(existing.map((e) => e.mentionedUserId));
      const toCreate = keptIds.filter((id) => !existingIds.has(id));
      if (toCreate.length === 0) return;

      const snippet = content.slice(0, MENTION_LIMITS.snippetLength);

      // createMany + skipDuplicates is race-safe against the unique constraint: if a
      // concurrent edit created the same (messageId,userId) between our read and write,
      // it is silently skipped (we just won't double-notify it — acceptable best-effort).
      await this.db.mention.createMany({
        data: toCreate.map((mentionedUserId) => ({
          mentionedUserId,
          mentionerUserId: authorId,
          sourceType: 'messenger',
          sourceId: chatId,
          chatId,
          messageId,
          snippet,
        })),
        skipDuplicates: true,
      });

      // Notify only the newly-recorded people.
      const author = await this.db.user.findUnique({
        where: { id: authorId },
        select: USER_LITE,
      });
      const mentionerName = fullName(author);
      const actionUrl = `/messenger?chat=${chatId}`;
      for (const userId of toCreate) {
        try {
          await this.notifications.notify(
            userId,
            'mention.received',
            { mentionerName, snippet },
            { actionUrl },
          );
        } catch (e) {
          this.logger.warn(`mention notify failed for ${userId}: ${String(e)}`);
        }
      }
    } catch (e) {
      // Best-effort: a mention failure must NEVER break sendMessage/editMessage.
      this.logger.warn(`recordMessageMentions failed (message ${messageId}): ${String(e)}`);
    }
  }

  /** The Mentions Hub feed for a user: keyset pagination by (createdAt desc, id desc). */
  async listFeed(userId: string, cursor?: string): Promise<MentionFeed> {
    const limit = MENTION_LIMITS.feedPageSize;

    const where: Prisma.MentionWhereInput = { mentionedUserId: userId };
    const decoded = decodeCursor(cursor);
    if (decoded) {
      where.OR = [
        { createdAt: { lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { lt: decoded.id } },
      ];
    }

    const [rows, unreadCount] = await Promise.all([
      this.db.mention.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.mention.count({ where: { mentionedUserId: userId, readAt: null } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    // Batch-resolve mentioner names/avatars (no N+1).
    const mentionerIds = [...new Set(page.map((r) => r.mentionerUserId))];
    const users = mentionerIds.length
      ? await this.db.user.findMany({ where: { id: { in: mentionerIds } }, select: USER_LITE })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Batch-resolve context titles for messenger mentions (the chat's title; null for DMs).
    const chatIds = [
      ...new Set(page.map((r) => r.chatId).filter((id): id is string => !!id)),
    ];
    const chats = chatIds.length
      ? await this.db.chat.findMany({ where: { id: { in: chatIds } }, select: { id: true, title: true } })
      : [];
    const chatTitleById = new Map(chats.map((c) => [c.id, c.title]));

    const items: MentionItem[] = page.map((r) => {
      const mentioner = userById.get(r.mentionerUserId);
      const sourceType = r.sourceType as MentionSourceType;
      // DM chats have no title → fall back to the mentioner's name for context.
      const contextTitle =
        (r.chatId ? chatTitleById.get(r.chatId) ?? null : null) ?? fullName(mentioner);
      return {
        id: r.id,
        mentionerUserId: r.mentionerUserId,
        mentionerName: fullName(mentioner),
        mentionerAvatar: mentioner?.avatar ?? null,
        sourceType,
        sourceId: r.sourceId,
        chatId: r.chatId,
        messageId: r.messageId,
        snippet: r.snippet,
        contextTitle,
        url: this.urlFor(sourceType, r.sourceId, r.chatId),
        read: !!r.readAt,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return { items, unreadCount, nextCursor };
  }

  /** Deep link into the source context for a mention row. */
  private urlFor(
    sourceType: MentionSourceType,
    sourceId: string,
    chatId: string | null,
  ): string {
    switch (sourceType) {
      case 'messenger':
        return `/messenger?chat=${chatId ?? sourceId}`;
      case 'task':
        return `/tasks/${sourceId}`;
      case 'calendar':
        return `/calendar?event=${sourceId}`;
      case 'listing':
        return `/shop?listing=${sourceId}`;
      default:
        return '/';
    }
  }

  /**
   * Mark this user's mentions read. Empty/omitted ids → mark ALL unread for the user.
   * A user can never mark someone else's mentions (mentionedUserId is always pinned to them).
   */
  async markRead(userId: string, ids?: string[]): Promise<void> {
    const where: Prisma.MentionWhereInput = { mentionedUserId: userId, readAt: null };
    if (ids && ids.length > 0) where.id = { in: ids };
    await this.db.mention.updateMany({ where, data: { readAt: new Date() } });
  }

  /**
   * The @-picker's candidate list for a chat: active members the viewer may mention.
   * Verifies the viewer can VIEW the chat (engine), then returns the OTHER active members
   * (excluding the viewer), optionally filtered by a case-insensitive substring on the name,
   * capped at ~20.
   */
  async mentionableMembers(
    viewerId: string,
    chatId: string,
    q?: string,
  ): Promise<MentionCandidate[]> {
    const ok = await this.access.can({ type: 'user', id: viewerId }, 'chat.view', chatId);
    if (!ok) return [];

    const members = await this.db.chatMember.findMany({
      where: { chatId, leftAt: null, userId: { not: viewerId } },
      include: { user: { select: USER_LITE } },
    });

    const needle = (q ?? '').trim().toLowerCase();
    const candidates = members
      .map((m) => ({
        userId: m.userId,
        name: fullName(m.user),
        avatar: m.user.avatar,
      }))
      .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);

    return candidates;
  }
}

/** Opaque keyset cursor: "<ISO createdAt>_<id>". Neither part contains '_'. */
function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf('_');
  if (idx === -1) return null;
  const createdAt = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}
