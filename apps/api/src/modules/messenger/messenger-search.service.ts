import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SearchResultItem } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { SearchRegistry } from '../../core/search/search.registry';
import { SearchProjectionService } from '../../core/search/search-projection.service';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

/** Raw row shape for the indexed message search. */
interface MessageHitRow {
  messageId: string;
  chatId: string;
  seq: number;
  body: string | null;
  itemCreatedAt: Date;
  chatTitle: string | null;
  chatType: string;
  score: number;
}

/**
 * Messenger's adapter to the unified search engine (Phase 6). Registers three providers and
 * projects messages into the index:
 *  • message — INDEXED (search_documents); the big content. Permission-trimmed in SQL by an
 *    active ChatMember JOIN + seq >= visibleFromSeq (a user can't find messages from before
 *    they joined, or in chats they're not in).
 *  • chat    — LIVE (chats are a small per-user set): group/context chats by title, trimmed by
 *    active membership. DMs (no title) surface via the person provider instead.
 *  • person  — LIVE: the viewer's Окружение (ContactLink) by name → opens a DM.
 *
 * Only text messages are indexed; system/rich_card/deleted are excluded. The index is a pure
 * cache (rebuildable via scripts/backfill-search.cjs); a deleted chat's orphaned rows never
 * surface because the message query JOINs chats/chat_members.
 */
@Injectable()
export class MessengerSearchService implements OnModuleInit {
  private readonly logger = new Logger(MessengerSearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: SearchRegistry,
    private readonly projection: SearchProjectionService,
  ) {}

  onModuleInit(): void {
    // Registration order = global-search group order: Чаты, Люди, Сообщения.
    this.registry.register({ type: 'chat', label: 'Чаты', search: (v, q, o) => this.searchChats(v, q, o) });
    this.registry.register({ type: 'person', label: 'Люди', search: (v, q, o) => this.searchPeople(v, q, o) });
    this.registry.register({
      type: 'message',
      label: 'Сообщения',
      search: (v, q, o) => this.searchMessages(v, q, o),
      reconcile: () => this.reconcileRecentMessages(),
    });
  }

  // ============================================================
  // Projection (called by MessengerService message hooks; best-effort there).
  // ============================================================
  async indexMessage(msg: {
    id: string;
    chatId: string;
    authorId: string | null;
    content: string | null;
    seq: number;
    type: string;
    createdAt: Date;
    deletedAt?: Date | null;
    workspaceId?: string | null;
  }): Promise<void> {
    // Searchable: plain text + attachment captions (caption живёт в content — К-1);
    // a soft-delete removes it from the index.
    if (!['text', 'attachment'].includes(msg.type) || msg.deletedAt) {
      await this.projection.remove('message', msg.id);
      return;
    }
    if (!msg.content) return;
    await this.projection.upsert({
      sourceType: 'message',
      sourceId: msg.id,
      url: `/messenger?chat=${msg.chatId}&msg=${msg.id}`,
      body: msg.content,
      chatId: msg.chatId,
      seq: msg.seq,
      authorId: msg.authorId,
      workspaceId: msg.workspaceId ?? null,
      itemCreatedAt: msg.createdAt,
    });
  }

  async removeMessage(messageId: string): Promise<void> {
    await this.projection.remove('message', messageId);
  }

  /** Drop every indexed row for a chat (its messages) — call when a chat is deleted. */
  async removeChat(chatId: string): Promise<void> {
    await this.projection.removeByChat(chatId);
  }

  // ============================================================
  // Providers.
  // ============================================================
  private async searchMessages(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const limit = Math.min(opts.limit, 50);
    const isPage = opts.mode === 'page';
    const tsq = Prisma.sql`websearch_to_tsquery('russian', ${query})`;
    const chatFilter = opts.chatId ? Prisma.sql`AND sd.chat_id = ${opts.chatId}` : Prisma.empty;

    // page mode → STABLE recency keyset (in-chat search / "показать ещё");
    // global mode → RELEVANCE ranking, no pagination.
    let keysetFilter = Prisma.empty;
    let order: Prisma.Sql;
    if (isPage) {
      const cur = decodeRecencyCursor(opts.cursor);
      if (cur) {
        keysetFilter = Prisma.sql`AND (sd.item_created_at < ${cur.ts} OR (sd.item_created_at = ${cur.ts} AND sd.source_id < ${cur.id}))`;
      }
      order = Prisma.sql`ORDER BY sd.item_created_at DESC, sd.source_id DESC`;
    } else {
      order = Prisma.sql`ORDER BY (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, coalesce(sd.body, ''))) DESC, sd.item_created_at DESC`;
    }

    const querySql = Prisma.sql`
      SELECT sd.source_id AS "messageId", sd.chat_id AS "chatId", sd.seq AS "seq",
             sd.body AS "body", sd.item_created_at AS "itemCreatedAt",
             c.title AS "chatTitle", c.type AS "chatType",
             (ts_rank(sd.search_vector, ${tsq}) * 4 + word_similarity(${query}, coalesce(sd.body, '')))::float8 AS "score"
      FROM search_documents sd
      JOIN chat_members cm ON cm.chat_id = sd.chat_id AND cm.user_id = ${viewerId} AND cm.left_at IS NULL
      JOIN chats c ON c.id = sd.chat_id
      WHERE sd.source_type = 'message'
        AND sd.seq >= cm.visible_from_seq
        ${chatFilter}
        ${keysetFilter}
        AND (sd.search_vector @@ ${tsq} OR ${query} <% coalesce(sd.body, ''))
      ${order}
      LIMIT ${limit}
    `;

    // Lower the trigram word-similarity threshold (default 0.6 → 0.4) for this query only,
    // so typo/partial matches in message bodies surface while `<%` still uses the GIN index.
    const result = await this.db.$transaction([
      this.db.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`,
      this.db.$queryRaw<MessageHitRow[]>(querySql),
    ]);
    const rows = (result[1] as MessageHitRow[]) ?? [];

    // Fill DM titles (DM chats carry no stored title) with the peer's name.
    const dmChatIds = [...new Set(rows.filter((r) => r.chatType === 'dm').map((r) => r.chatId))];
    const peerName = new Map<string, string>();
    if (dmChatIds.length) {
      const peers = await this.db.chatMember.findMany({
        where: { chatId: { in: dmChatIds }, userId: { not: viewerId }, leftAt: null },
        include: { user: { select: USER_LITE } },
      });
      for (const p of peers) peerName.set(p.chatId, fullName(p.user));
    }

    const items: SearchResultItem[] = rows.map((r) => ({
      type: 'message',
      id: r.messageId,
      title: r.chatTitle ?? peerName.get(r.chatId) ?? 'Личный чат',
      snippet: makeSnippet(r.body, query),
      url: `/messenger?chat=${r.chatId}&msg=${r.messageId}`,
      chatId: r.chatId,
      messageId: r.messageId,
      avatar: null,
      createdAt: toIso(r.itemCreatedAt),
      score: r.score ?? 0,
    }));

    // Pagination only in page mode (stable recency keyset).
    let nextCursor: string | null = null;
    if (isPage && rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = encodeRecencyCursor(last.itemCreatedAt, last.messageId);
    }
    return { items, nextCursor };
  }

  private async searchChats(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const limit = Math.min(opts.limit, 50);
    // Substring (case-insensitive) on the chat title — natural "type a few letters" behaviour.
    // DMs have a null title → excluded here (found via the person provider).
    const members = await this.db.chatMember.findMany({
      where: {
        userId: viewerId,
        leftAt: null,
        chat: { title: { contains: query, mode: 'insensitive' } },
      },
      include: { chat: { select: { id: true, title: true, createdAt: true } } },
      orderBy: { chat: { createdAt: 'desc' } },
      take: limit,
    });

    const items: SearchResultItem[] = members.map((m) => ({
      type: 'chat',
      id: m.chat.id,
      title: m.chat.title ?? 'Чат',
      snippet: null,
      url: `/messenger?chat=${m.chat.id}`,
      chatId: m.chat.id,
      messageId: null,
      avatar: null,
      createdAt: toIso(m.chat.createdAt),
      score: 1,
    }));
    return { items };
  }

  private async searchPeople(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const limit = Math.min(opts.limit, 50);
    // Окружение is bounded per user → live name match (cap the scan defensively).
    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: viewerId }, { userBId: viewerId }] },
      include: { userA: { select: USER_LITE }, userB: { select: USER_LITE } },
      take: 500,
    });
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const items: SearchResultItem[] = [];
    for (const l of links) {
      const other = l.userAId === viewerId ? l.userB : l.userA;
      if (!other || seen.has(other.id)) continue;
      const name = fullName(other);
      if (!name.toLowerCase().includes(needle)) continue;
      seen.add(other.id);
      items.push({
        type: 'person',
        id: other.id,
        title: name,
        snippet: null,
        url: `/messenger?dm=${other.id}`,
        chatId: null,
        messageId: null,
        avatar: other.avatar ?? null,
        createdAt: null,
        score: 1,
      });
      if (items.length >= limit) break;
    }
    return { items };
  }

  // ============================================================
  // Reconcile (bounded): re-index recent text messages to catch any missed live hook.
  // The full initial build is scripts/backfill-search.cjs.
  // ============================================================
  private async reconcileRecentMessages(): Promise<number> {
    const since = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const msgs = await this.db.message.findMany({
      where: { type: { in: ['text', 'attachment'] }, deletedAt: null, content: { not: null }, createdAt: { gte: since } },
      select: { id: true, chatId: true, authorId: true, content: true, seq: true, type: true, createdAt: true },
      take: 5000,
    });
    for (const m of msgs) {
      try {
        await this.indexMessage(m);
      } catch (e) {
        this.logger.warn(`reconcile indexMessage failed for ${m.id}: ${String(e)}`);
      }
    }
    return msgs.length;
  }
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/**
 * A snippet centered on the first matched query word (Telegram-style), with ellipses.
 * Falls back to the head of the text when no exact query word is present (e.g. a pure
 * stem match) — the web layer still highlights the term.
 */
function makeSnippet(body: string | null, query: string): string {
  const text = (body ?? '').trim();
  if (text.length <= 160) return text;
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  const lower = text.toLowerCase();
  let idx = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return text.slice(0, 160).trimEnd() + '…';
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + 100);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** Recency keyset cursor for page-mode message search: "<ISO item_created_at>_<messageId>". */
function encodeRecencyCursor(itemCreatedAt: Date | string, id: string): string {
  return `${toIso(itemCreatedAt)}_${id}`;
}

function decodeRecencyCursor(cursor?: string): { ts: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf('_');
  if (idx === -1) return null;
  const ts = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(ts.getTime()) || !id) return null;
  return { ts, id };
}
