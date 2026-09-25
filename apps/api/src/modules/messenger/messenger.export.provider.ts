import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor, withoutPersonIds } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { fullNameOrNull } from '../../shared/utils/user-name';
import { LifecycleExportRegistry, type LifecycleExportContext, type LifecycleExportPage } from '../../core/lifecycle/lifecycle.export.registry';
import { MessengerRetentionService } from './messenger-retention.service';

const CHAT_CURSOR = { c: 'uuid' } as const;
const MESSAGE_CURSOR = { c: 'uuid', s: 'number' } as const;
/** Упоминание в тексте `@[Имя](uuid)` → `@Имя`: id людей в архив не уходят. */
const MENTION = /@\[([^\]]+)\]\([0-9a-f-]{36}\)/gi;

type Row = Record<string, unknown>;

interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  author_id: string | null;
  type: string;
  content: string | null;
  payload: unknown;
  reply_to_id: string | null;
  edited_at: Date | null;
  created_at: Date;
}

interface ExportChatRow {
  id: string;
  type: string;
  workspace_id: string | null;
  message_ttl_days: number | null;
  visible_from_seq: number | null;
}

/**
 * Мессенджер в выгрузке данных (core/lifecycle Э6) — правила чтения ленты, которых общий
 * сборщик не знает:
 *  - человек: личные чаты (переписка и личные группы) — как их видит он сам: с его
 *    `visibleFromSeq`, в сроке чата (таймер / срок организации), без удалённого; в чатах
 *    организации — только его собственные сообщения (переписка организации принадлежит ей).
 *    Чужой автор — имя без id и телефона, чужие вложения — числом, без файлов; упоминания
 *    `@[Имя](id)` → `@Имя`; системная плашка — без id людей;
 *  - организация: её чаты целиком в сроке её политики — участники её, id остаются.
 */
@Injectable()
export class MessengerExportProvider implements OnModuleInit {
  constructor(
    private readonly registry: LifecycleExportRegistry,
    private readonly db: DatabaseService,
    private readonly retention: MessengerRetentionService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    for (const side of ['user', 'workspace'] as const) {
      this.registry.register('Chat', side, {
        page: (ctx, cursor, limit) => this.chatsPage(ctx, cursor, limit),
        verify: (ctx, rows) => this.chatsOwned(ctx, rows.map((r) => String(r.id))),
      });
      this.registry.register('Message', side, {
        page: (ctx, cursor, limit) => this.messagesPage(ctx, cursor, limit),
        verify: (ctx, rows) => this.messagesOwned(ctx, rows.map((r) => String(r.id))),
      });
    }
  }

  // ---- Чаты ----

  private async chatsPage(ctx: LifecycleExportContext, cursor: string | null, limit: number): Promise<LifecycleExportPage> {
    const after = decodeCursor(cursor, CHAT_CURSOR)?.c ?? null;
    const where: Prisma.ChatWhereInput =
      ctx.side === 'user'
        ? { workspaceId: null, members: { some: { userId: ctx.subjectId, leftAt: null } } }
        : { workspaceId: ctx.subjectId };
    const chats = await this.db.chat.findMany({
      where: { ...where, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, type: true, title: true, parentType: true, parentId: true, createdById: true, createdAt: true, messageTtlDays: true, workspaceId: true },
    });
    const rows: Row[] = [];
    if (ctx.side === 'user') {
      // Собеседник личной переписки — имя, без id
      const dmIds = chats.filter((c) => c.type === 'dm').map((c) => c.id);
      const peers = dmIds.length
        ? await this.db.chatMember.findMany({
            where: { chatId: { in: dmIds }, userId: { not: ctx.subjectId } },
            select: { chatId: true, user: { select: { firstName: true, lastName: true, deletedAt: true } } },
          })
        : [];
      const peerOf = new Map(peers.map((p) => [p.chatId, this.name(ctx, p.user)]));
      for (const c of chats) {
        rows.push({
          id: c.id,
          type: c.type,
          title: c.title,
          with: c.type === 'dm' ? (peerOf.get(c.id) ?? null) : null,
          createdByMe: c.createdById === ctx.subjectId,
          autoDeleteDays: c.messageTtlDays,
          createdAt: c.createdAt.toISOString(),
        });
      }
    } else {
      for (const c of chats) {
        rows.push({ id: c.id, type: c.type, title: c.title, parentType: c.parentType, parentId: c.parentId, createdById: c.createdById, autoDeleteDays: c.messageTtlDays, createdAt: c.createdAt.toISOString() });
      }
    }
    const last = chats[chats.length - 1];
    return { rows, next: chats.length === limit && last ? encodeCursor({ c: last.id }) : null };
  }

  /**
   * Перепроверка владельца — «чужого нет», а не «ничего не изменилось»: чат, удалённый между
   * страницей и проверкой, не чужой (в живой организации что-то удаляют постоянно — иначе
   * выгрузка крупной организации падала бы почти всегда). Чужой — падение сборки целиком.
   */
  private async chatsOwned(ctx: LifecycleExportContext, ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return true;
    const chats = await this.db.chat.findMany({ where: { id: { in: [...ids] } }, select: { id: true, workspaceId: true } });
    if (ctx.side === 'workspace') return chats.every((c) => c.workspaceId === ctx.subjectId);
    const members = await this.db.chatMember.findMany({ where: { chatId: { in: [...ids] }, userId: ctx.subjectId, leftAt: null }, select: { chatId: true } });
    const mine = new Set(members.map((m) => m.chatId));
    return chats.every((c) => c.workspaceId === null && mine.has(c.id));
  }

  // ---- Сообщения ----

  private name(ctx: LifecycleExportContext, u: { firstName: string; lastName: string | null; deletedAt?: Date | null } | null | undefined): string {
    return fullNameOrNull(u) ?? this.i18n.translateFor(ctx.locale, 'common.labels.deletedUser');
  }

  /** Чат выгрузки: свой (личный участник) или организации; поля срока и видимости ленты. */
  private async exportChat(ctx: LifecycleExportContext, where: { id?: string; after?: string | null }): Promise<ExportChatRow | null> {
    const pick = where.id !== undefined ? Prisma.sql`c."id" = ${where.id}::uuid` : where.after ? Prisma.sql`c."id" > ${where.after}::uuid` : Prisma.sql`TRUE`;
    const [chat] =
      ctx.side === 'user'
        ? await this.db.$queryRaw<ExportChatRow[]>`
            SELECT c."id"::text AS id, c."type", c."workspace_id"::text AS workspace_id, c."message_ttl_days", cm."visible_from_seq"
              FROM "chat_members" cm JOIN "chats" c ON c."id" = cm."chat_id"
             WHERE cm."user_id" = ${ctx.subjectId}::uuid AND cm."left_at" IS NULL AND ${pick}
             ORDER BY c."id" LIMIT 1`
        : await this.db.$queryRaw<ExportChatRow[]>`
            SELECT c."id"::text AS id, c."type", c."workspace_id"::text AS workspace_id, c."message_ttl_days", NULL::int AS visible_from_seq
              FROM "chats" c
             WHERE c."workspace_id" = ${ctx.subjectId}::uuid AND ${pick}
             ORDER BY c."id" LIMIT 1`;
    return chat ?? null;
  }

  /**
   * Сообщения ОДНОГО чата после `after` — диапазон уникального индекса `(chat_id, seq)`: страница
   * стоит «страницу», а не сортировку всей переписки организации (общий запрос по всем чатам
   * сортировал бы на каждой странице все оставшиеся сообщения). Пол ленты (срок чата, вход в
   * группу) — в границе диапазона: истёкшее не читается вовсе.
   */
  private async chatMessages(ctx: LifecycleExportContext, chat: ExportChatRow, after: number, need: number): Promise<MessageRow[]> {
    const floor = await this.retention.floorOf({ id: chat.id, type: chat.type, workspaceId: chat.workspace_id, messageTtlDays: chat.message_ttl_days });
    const from = Math.max(after, floor - 1, (chat.visible_from_seq ?? 0) - 1);
    // Человек в чате организации забирает только свои сообщения (переписка организации — её)
    const own = ctx.side === 'user' && chat.workspace_id ? Prisma.sql`AND m."author_id" = ${ctx.subjectId}::uuid` : Prisma.empty;
    return this.db.$queryRaw<MessageRow[]>`
      SELECT m."id"::text AS id, m."chat_id"::text AS chat_id, m."seq", m."author_id"::text AS author_id, m."type", m."content", m."payload",
             m."reply_to_id"::text AS reply_to_id, m."edited_at", m."created_at"
        FROM "messages" m
       WHERE m."chat_id" = ${chat.id}::uuid AND m."seq" > ${from}::int AND m."deleted_at" IS NULL ${own}
       ORDER BY m."seq" LIMIT ${need}`;
  }

  private async messagesPage(ctx: LifecycleExportContext, cursor: string | null, limit: number): Promise<LifecycleExportPage> {
    const cur = decodeCursor(cursor, MESSAGE_CURSOR);
    // Курсор — «чат и последний seq в нём». Чат курсора пропал (удалён, человек вышел) — дальше со следующего
    let chat = cur ? ((await this.exportChat(ctx, { id: cur.c })) ?? (await this.exportChat(ctx, { after: cur.c }))) : await this.exportChat(ctx, { after: null });
    let after = cur && chat?.id === cur.c ? cur.s : 0;
    const rows: MessageRow[] = [];
    while (chat && rows.length < limit) {
      const need = limit - rows.length;
      const part = await this.chatMessages(ctx, chat, after, need);
      rows.push(...part);
      if (part.length === need) {
        after = Number(part[part.length - 1]!.seq);
        break;
      }
      chat = await this.exportChat(ctx, { after: chat.id });
      after = 0;
    }
    const next = chat && rows.length === limit ? encodeCursor({ c: chat.id, s: after }) : null;

    const authorIds = [...new Set(rows.map((r) => r.author_id).filter((x): x is string => !!x))];
    const authors = authorIds.length ? await this.db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true, deletedAt: true } }) : [];
    const byId = new Map(authors.map((a) => [a.id, a]));
    const out: Row[] = rows.map((r) => {
      const mine = r.author_id === ctx.subjectId;
      const text = r.content ? r.content.replace(MENTION, '@$1') : null;
      const base: Row = {
        id: r.id,
        chatId: r.chat_id,
        seq: Number(r.seq),
        type: r.type,
        text,
        replyToId: r.reply_to_id,
        editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      };
      if (ctx.side === 'workspace') {
        return { ...base, authorId: r.author_id, author: r.author_id ? this.name(ctx, byId.get(r.author_id)) : null, payload: r.payload ?? null };
      }
      return {
        ...base,
        mine,
        author: mine ? null : r.author_id ? this.name(ctx, byId.get(r.author_id)) : null,
        payload: this.personalPayload(r, mine),
      };
    });
    return { rows: out, next };
  }

  /**
   * Payload в архиве человека: своё вложение — описание файлов (байты — в `files/` архива), чужое —
   * только число файлов; системная плашка — без id людей; рич-карта — вид и заголовок.
   */
  private personalPayload(r: MessageRow, mine: boolean): unknown {
    const p = r.payload && typeof r.payload === 'object' ? (r.payload as Row) : null;
    if (!p) return null;
    if (r.type === 'attachment') {
      const files = Array.isArray(p.files) ? (p.files as Row[]) : [];
      return mine ? { files: files.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size, mime: f.mime })) } : { files: files.length };
    }
    if (r.type === 'system') return withoutPersonIds(p);
    if (r.type === 'rich_card') return { cardType: p.cardType ?? null, title: p.title ?? null };
    return null;
  }

  /** Как у чатов: удалённое между страницей и проверкой — не чужое; чужое — стоп. */
  private async messagesOwned(ctx: LifecycleExportContext, ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return true;
    const msgs = await this.db.message.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, authorId: true, chatId: true, chat: { select: { workspaceId: true } } },
    });
    if (ctx.side === 'workspace') return msgs.every((m) => m.chat.workspaceId === ctx.subjectId);
    const members = await this.db.chatMember.findMany({ where: { chatId: { in: [...new Set(msgs.map((m) => m.chatId))] }, userId: ctx.subjectId, leftAt: null }, select: { chatId: true } });
    const mine = new Set(members.map((m) => m.chatId));
    return msgs.every((m) => mine.has(m.chatId) && (m.chat.workspaceId === null || m.authorId === ctx.subjectId));
  }
}
