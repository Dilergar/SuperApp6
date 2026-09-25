import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor, type LifecyclePolicy } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../../core/files/files.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
  type LifecyclePurgeBatchContext,
} from '../../core/lifecycle/lifecycle.purge.registry';
import { LifecycleSettings } from '../../core/lifecycle/lifecycle.settings';
import { deletableSql, lifecycleTableOf, lockHoldsShared, type LifecycleTable } from '../../core/lifecycle/lifecycle.sql';
import { MessengerSearchService } from './messenger-search.service';
import { MessengerService } from './messenger.service';

const RETENTION_CURSOR = { w: 'uuid', c: 'uuid?' } as const;
/** Курсор фазы таймеров: после организаций раннер идёт по чатам с таймером. */
const TIMER_CURSOR = { p: 'string', t: 'uuid?' } as const;

/**
 * Мессенджер в движке сроков core/lifecycle:
 *  - `messenger.retention` (политика `Message`) — срок переписки организации выбирает
 *    организация (коридор, класс `user_content_shared`): сообщения её чатов старше срока
 *    уходят пачками по (чат, seq), удерживаемые заморозкой остаются; поиск и вложения
 *    добирает loose FK. Умолчание — вечно (без настройки шаг ничего не делает);
 *  - `messenger.workspace-chats` (политика `Chat`) — каскад организации: её чаты;
 *  - `messenger.subject` (политика `ChatMember`) — стирание человека: по выбору в мастере —
 *    все его сообщения томбстоуном, затем выход из групп и контекстных чатов (личные чаты
 *    остаются собеседнику, автор — томбстоун).
 */
@Injectable()
export class MessengerLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly settings: LifecycleSettings,
    private readonly messenger: MessengerService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
    private readonly files: FilesService,
    private readonly search: MessengerSearchService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('messenger.retention', {
      purgeBatch: (ctx) => this.retentionBatch(ctx),
    });
    this.tenantHooks.register('messenger.workspace-chats', {
      purge: (workspaceId, ctx) =>
        this.messenger.purgeWorkspaceChats(workspaceId, {
          deadline: ctx.deadline,
          checkpoint: () => ctx.checkpoint(),
          releasable: (tx, ids) => ctx.releasable(tx, 'Chat', ids),
        }),
      estimate: (workspaceId) => this.db.message.count({ where: { chat: { workspaceId } } }),
    });
    this.subjectHooks.register('messenger.subject', { erase: (userId, ctx) => this.messenger.eraseMember(userId, ctx) });
    this.canary.register('messenger.subject', (ctx) => this.seedCanary(ctx));
  }

  /**
   * Посев канарейки (стирание идёт с выбором «стереть все мои сообщения»): личный чат с
   * соседом — текст (с проекцией поиска) и вложение человека становятся томбстоунами, файл
   * вложения исчезает, ответ соседа и строки участников остаются собеседнику; отложенное
   * сообщение человека исчезает; его группа переходит соседу, членство человека уходит, плашки
   * о нём остаются без его имени.
   */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const u = ctx.userId;
    const p = ctx.peerId;
    const tuples = (chatId: string) => [u, p].map((uid) => ({ resourceType: 'chat', resourceId: chatId, relation: 'member', subjectType: 'user', subjectId: uid, subjectRelation: '' }));
    const dm = await this.db.$transaction(async (tx) => {
      const c = await tx.chat.create({
        data: { type: 'dm', dmKey: [u, p].sort().join(':'), lastSeq: 3, members: { create: [{ userId: u }, { userId: p }] } },
        select: { id: true, members: { select: { id: true } } },
      });
      await tx.relationTuple.createMany({ data: tuples(c.id), skipDuplicates: true });
      return c;
    });
    const file = await this.files.createCanaryFile({ profile: 'chat_attachment', ownerType: 'user', ownerId: u, uploaderId: u, name: `${ctx.marker}.txt`, mime: 'text/plain', content: ctx.marker });
    const now = new Date();
    const msgs = await this.db.$transaction(async (tx) => {
      const text = await tx.message.create({ data: { chatId: dm.id, authorId: u, type: 'text', content: ctx.marker, seq: 1, createdAt: now }, select: { id: true } });
      const att = await tx.message.create({ data: { chatId: dm.id, authorId: u, type: 'attachment', content: ctx.marker, payload: { fileId: file.id, name: `${ctx.marker}.txt` }, seq: 2 }, select: { id: true } });
      const reply = await tx.message.create({ data: { chatId: dm.id, authorId: p, type: 'text', content: 'canary peer', seq: 3 }, select: { id: true } });
      await this.files.linkSystemInTx(tx, { fileId: file.id, refType: 'chat_message', refId: att.id, role: 'attachment', createdById: u });
      return { text, att, reply };
    });
    await this.search.indexMessage({ id: msgs.text.id, chatId: dm.id, authorId: u, content: ctx.marker, seq: 1, type: 'text', createdAt: now, workspaceId: null });
    const doc = await this.db.searchDocument.findFirst({ where: { sourceType: 'message', sourceId: msgs.text.id }, select: { id: true } });
    const scheduled = await this.db.scheduledMessage.create({ data: { chatId: dm.id, authorId: u, content: ctx.marker, sendAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    // Группа с двумя плашками об этом человеке: он актор («создал группу») и цель («назначен
    // администратором»). Плашки остаются собеседнику — имени в них после стирания нет
    const name = `Canary ${ctx.name}`;
    const group = await this.db.$transaction(async (tx) => {
      const c = await tx.chat.create({
        data: { type: 'group', title: ctx.marker, createdById: u, lastSeq: 2, members: { create: [{ userId: u, role: 'owner' }, { userId: p, role: 'member' }] } },
        select: { id: true, members: { select: { id: true, userId: true } } },
      });
      await tx.relationTuple.createMany({ data: tuples(c.id), skipDuplicates: true });
      const created = await tx.message.create({
        data: { chatId: c.id, type: 'system', seq: 1, payload: { eventType: 'group.created', text: `${name} created the group`, chatter: { refType: 'chat', actorName: name, actorId: u, payload: { actorName: name, name: ctx.marker } } } },
        select: { id: true },
      });
      const granted = await tx.message.create({
        data: { chatId: c.id, type: 'system', seq: 2, payload: { eventType: 'group.admin_granted', text: `${name} was made an administrator`, chatter: { refType: 'chat', actorName: null, payload: { targetName: name, targetUserId: u } } } },
        select: { id: true },
      });
      return { ...c, plaques: [created.id, granted.id] };
    });
    return [
      { policy: 'Chat', id: dm.id, expect: 'kept' },
      ...dm.members.map((m) => ({ policy: 'ChatMember', id: m.id, expect: 'kept' as const })),
      { policy: 'Message', id: msgs.text.id, expect: 'scrubbed' },
      { policy: 'Message', id: msgs.att.id, expect: 'scrubbed' },
      { policy: 'Message', id: msgs.reply.id, expect: 'kept' },
      { policy: 'FileObject', id: file.id, expect: 'gone' },
      { policy: 'blob:chat_attachment', id: file.storageKey, expect: 'gone' },
      ...(doc ? [{ policy: 'SearchDocument', id: doc.id, expect: 'gone' as const }] : []),
      { policy: 'ScheduledMessage', id: scheduled.id, expect: 'gone' },
      { policy: 'Chat', id: group.id, expect: 'kept' },
      ...group.members.map((m) => ({ policy: 'ChatMember', id: m.id, expect: m.userId === u ? ('gone' as const) : ('kept' as const) })),
      ...group.plaques.map((id) => ({ policy: 'Message', id, expect: 'kept' as const })),
    ];
  }

  /**
   * Одна пачка срока сообщений: сначала организации с конечным сроком (по курсору организации и
   * чата), затем чаты с таймером автоудаления (по курсору чата). Под заморозкой — остаются.
   */
  private async retentionBatch({ policy, limit, cursor }: LifecyclePurgeBatchContext) {
    const table = lifecycleTableOf(policy);
    if (!table) return { rows: 0, more: false, cursor: null };
    const timerCursor = decodeCursor(cursor, TIMER_CURSOR);
    if (!timerCursor) {
      const c = decodeCursor(cursor, RETENTION_CURSOR);
      for (const t of await this.settings.tenantRetentions(policy)) {
        if (c && t.workspaceId < c.w) continue;
        const cutoff = new Date(Date.now() - t.days * 86_400_000);
        let afterChat = c && t.workspaceId === c.w ? c.c : null;
        for (;;) {
          const chats = await this.db.chat.findMany({
            where: { workspaceId: t.workspaceId, ...(afterChat ? { id: { gt: afterChat } } : {}) },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 100,
          });
          if (!chats.length) break;
          for (const chat of chats) {
            const n = await this.deleteOlder(policy, table, chat.id, cutoff, limit);
            if (n > 0) return { rows: n, more: true, cursor: encodeCursor({ w: t.workspaceId, c: n >= limit ? afterChat : chat.id }) };
            afterChat = chat.id;
          }
        }
      }
    }
    // Таймеры чатов (человек выбрал 1/7/30 дней)
    let afterChat = timerCursor?.t ?? null;
    for (;;) {
      const chats = await this.db.chat.findMany({
        where: { messageTtlDays: { not: null }, ...(afterChat ? { id: { gt: afterChat } } : {}) },
        select: { id: true, messageTtlDays: true },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (!chats.length) break;
      for (const chat of chats) {
        const cutoff = new Date(Date.now() - chat.messageTtlDays! * 86_400_000);
        const n = await this.deleteOlder(policy, table, chat.id, cutoff, limit);
        if (n > 0) return { rows: n, more: true, cursor: encodeCursor({ p: 'timers', t: n >= limit ? afterChat : chat.id }) };
        afterChat = chat.id;
      }
    }
    return { rows: 0, more: false, cursor: null };
  }

  /** Пачка сообщений чата старше момента — по seq, под общим замком заморозок, удерживаемое — мимо. */
  private deleteOlder(policy: LifecyclePolicy, table: LifecycleTable, chatId: string, cutoff: Date, limit: number): Promise<number> {
    return this.db.$transaction(async (tx) => {
      await lockHoldsShared(tx);
      await tx.$executeRaw`SELECT set_config('lock_timeout', '1000ms', true)`;
      return tx.$executeRaw(Prisma.sql`
        DELETE FROM "messages" t
         USING (
           SELECT t.id FROM "messages" t
            WHERE t.chat_id = ${chatId}::uuid AND t.created_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
              AND ${deletableSql(policy, table)}
            ORDER BY t.seq
            LIMIT ${limit}
            FOR UPDATE OF t SKIP LOCKED
         ) d
        WHERE t.id = d.id`);
    });
  }
}
