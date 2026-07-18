import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { fullName } from '../../shared/utils/user-name';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AccessService } from '../../core/access/access.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { ContactsService } from '../contacts/contacts.service';
import { MentionsService } from './mentions.service';
import { MessengerSearchService } from './messenger-search.service';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { CallsService } from '../../core/calls/calls.service';
import { CallsRefRegistry } from '../../core/calls/calls-ref.registry';
import { MESSENGER_LIMITS, OFFICE_ROOM_ROLE_LABELS, attachmentPreviewText } from '@superapp/shared';
import type {
  CallActiveDto,
  ChatCallStatePayload,
  ChatSummary,
  ChatMessage,
  ChatDetail,
  ChatMemberRole,
  MessagePreview,
  MessageDeliveryStatus,
  ChatParticipantInfo,
  SystemMessageEvent,
  RichCardPayload,
  MessageReplyPreview,
  AttachmentsPayload,
} from '@superapp/shared';

type Principal = { type: string; id: string };

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

// Message include with the quoted message (Phase 7 reply/quote) — used wherever a message
// is serialized for display (getMessages, send, edit) so the reply chip resolves with no N+1.
const MESSAGE_REPLY_INCLUDE = {
  author: { select: USER_LITE },
  replyTo: {
    select: {
      id: true,
      authorId: true,
      type: true,
      content: true,
      payload: true,
      deletedAt: true,
      author: { select: USER_LITE },
    },
  },
} satisfies Prisma.MessageInclude;

// Task role → Russian label shown next to an author's name in a task (context) chat.
const TASK_ROLE_LABELS: Record<string, string> = {
  creator: 'Постановщик',
  executor: 'Исполнитель',
  co_executor: 'Соисполнитель',
  observer: 'Наблюдатель',
};

// Order role → Russian label shown next to an author's name in an order (context) chat.
const ORDER_ROLE_LABELS: Record<string, string> = {
  buyer: 'Покупатель',
  seller: 'Продавец',
  contributor: 'Вкладчик',
};

// Event role → Russian label shown next to an author's name in an event (context) chat.
const EVENT_ROLE_LABELS: Record<string, string> = {
  organizer: 'Организатор',
  attendee: 'Участник',
};

/**
 * Messenger core. Phase 1: DM lifecycle + messages + read/delivery cursors.
 * Phase 2: ad-hoc GROUP chats (owner/admin/member, members from Окружение) and
 * task CONTEXT chats (one per task, members = creator + participants; replaces
 * TaskComment). Access is the engine's job (`chat` resource type in core/access):
 * group members are stored tuples, task members are usersets that follow the task's
 * roles (chat#member@task#<role>), so removal from a task = instant Hard Revoke.
 * ChatMember rows carry per-user state (cursors, mute, pin, visibleFromSeq) and
 * drive the inbox list.
 */
@Injectable()
export class MessengerService implements OnModuleInit {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private access: AccessService,
    private contacts: ContactsService,
    private accessProjection: AccessProjectionService,
    private mentions: MentionsService,
    private searchIndex: MessengerSearchService,
    private files: FilesService,
    private filesRegistry: FilesRefRegistry,
    private calls: CallsService,
    private callsRegistry: CallsRefRegistry,
    private redis: RedisService,
  ) {}

  onModuleInit(): void {
    // Ф9 (вложения): доступ к файлу наследуется от сообщения → чата (модель
    // Salesforce ContentDocumentLink; перепроверка на каждый доступ, тюплов нет).
    this.filesRegistry.register('chat_message', {
      canView: async (viewerId, messageId) => {
        const m = await this.db.message.findUnique({
          where: { id: messageId },
          select: { chatId: true, deletedAt: true },
        });
        if (!m || m.deletedAt) return false;
        return this.access.can(this.user(viewerId), 'chat.view', m.chatId);
      },
      canAttach: async (uid, messageId) => {
        const m = await this.db.message.findUnique({
          where: { id: messageId },
          select: { chatId: true, authorId: true, deletedAt: true },
        });
        if (!m || m.deletedAt || m.authorId !== uid) return false;
        return this.access.can(this.user(uid), 'chat.post', m.chatId);
      },
    }, { allowedProfiles: ['chat_attachment', 'voice_message'] });

    // Звонки в чатах (refType='chat', движок core/calls): DM с дозвоном, группы и
    // контекстные чаты — по модели «присоединиться». Доступ = chat.view; DM
    // дополнительно уважает личные блоки (как DM-сообщения). Чат офис-встречи
    // исключён: у сущности office_room уже есть собственный звонок (конфликт
    // двух активных сессий на одну встречу).
    this.callsRegistry.register('chat', {
      canJoin: async (uid, chatId) => {
        const chat = await this.db.chat.findUnique({
          where: { id: chatId },
          select: { type: true, parentType: true },
        });
        if (!chat || chat.parentType === 'office_room') return false;
        if (!(await this.access.can(this.user(uid), 'chat.view', chatId))) return false;
        if (chat.type === 'dm') {
          const peer = await this.db.chatMember.findFirst({
            where: { chatId, userId: { not: uid } },
            select: { userId: true },
          });
          if (!peer) return false;
          try {
            await this.assertInEnvironment(uid, peer.userId, { alwaysCheckBlocks: true });
          } catch {
            return false;
          }
        }
        return true;
      },
      // DM: оба участника — модераторы (трубка/отклонение = конец звонка для обоих,
      // WhatsApp-семантика). Группа: owner/admin. Контекстные: модераторов нет —
      // звонок затухает сам (departure_timeout LiveKit + реконсиляция кроном).
      canModerate: async (uid, chatId) => {
        const chat = await this.db.chat.findUnique({ where: { id: chatId }, select: { type: true } });
        if (!chat) return false;
        const member = await this.db.chatMember.findFirst({
          where: { chatId, userId: uid },
          select: { role: true },
        });
        if (!member) return false;
        if (chat.type === 'dm') return true;
        if (chat.type === 'group') return member.role === 'owner' || member.role === 'admin';
        return false;
      },
      // Фанаут call:state на выдачу токена (идемпотентный снимок). Важно: на этот момент
      // звонящий ещё НЕ в комнате (строка журнала появится с вебхуком participant_joined),
      // поэтому сам этот фанаут дозвон НЕ зажигает — ринг у DM-собеседника стартует, когда
      // придёт participant_joined (шина). Шина at-most-once → страховка: клиентский
      // CallsWatcher опрашивает /messenger/calls/active раз в 12с (восстанавливает
      // потерянное joined/ended). «Гарантией» этот путь называть нельзя — это snapshot+backstop.
      onJoinAuthorized: async (_uid, chatId) => {
        await this.broadcastCallState(chatId).catch(() => undefined);
      },
      resolveWorkspaceId: async (chatId) => {
        const chat = await this.db.chat.findUnique({
          where: { id: chatId },
          select: { workspaceId: true },
        });
        return chat?.workspaceId ?? null;
      },
    });
  }

  // ============================================================
  // Звонки в чатах — снимок call:state (см. ChatCallsListener)
  // ============================================================

  /** TTL кэша снимка call:state (≤ интервала клиентского поллинга — свежесть та же). */
  private static readonly CALL_STATE_TTL_SEC = 15;

  private callStateCacheKey(chatId: string): string {
    return `msgr:callstate:${chatId}`;
  }

  /**
   * Снимок звонка чата + аудитория. Один формат кормит socket call:state и
   * GET /messenger/calls/active (холодная загрузка watcher'а входящих).
   *
   * Redis-кэш (15с): при живом звонке в большой группе каждый поллер тянул всех
   * участников чата + звонящего — теперь один расчёт на всех зрителей; вебхуки
   * (broadcastCallState) строят свежий снимок и перезаписывают кэш.
   */
  private async buildCallStatePayload(
    chatId: string,
    preloaded?: CallActiveDto | null,
    opts?: { skipCache?: boolean },
  ): Promise<{ payload: ChatCallStatePayload; memberUserIds: string[] } | null> {
    if (!opts?.skipCache) {
      try {
        const raw = await this.redis.get(this.callStateCacheKey(chatId));
        if (raw) {
          const cached = JSON.parse(raw) as {
            payload: ChatCallStatePayload;
            memberUserIds: string[];
          };
          // Кэш валиден только для ТОЙ ЖЕ сессии: снимок «звонок завершён» не должен
          // маскировать новую сессию, начатую внутри TTL (и наоборот).
          const cachedSession = cached.payload.active?.sessionId ?? null;
          const askedSession = preloaded === undefined ? cachedSession : preloaded?.sessionId ?? null;
          if (cachedSession === askedSession) return cached;
        }
      } catch {
        /* кэш — best-effort */
      }
    }

    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        type: true,
        title: true,
        members: { select: { userId: true } },
      },
    });
    if (!chat) return null;
    const active =
      preloaded !== undefined
        ? preloaded
        : (await this.calls.getActiveForRefs('chat', [chatId])).get(chatId) ?? null;
    let startedByName: string | null = null;
    if (active) {
      const starter = await this.db.user.findUnique({
        where: { id: active.startedById },
        select: USER_LITE,
      });
      startedByName = starter ? fullName(starter) : null;
    }
    const built = {
      payload: {
        chatId,
        chatType: chat.type as ChatCallStatePayload['chatType'],
        // DM живёт без title (имя пира зависит от зрителя) — модалке входящего
        // хватает имени звонящего
        chatTitle: chat.title ?? startedByName ?? 'Звонок',
        startedByName,
        active,
      },
      memberUserIds: chat.members.map((m) => m.userId),
    };
    try {
      await this.redis.set(
        this.callStateCacheKey(chatId),
        JSON.stringify(built),
        MessengerService.CALL_STATE_TTL_SEC,
      );
    } catch {
      /* кэш — best-effort */
    }
    return built;
  }

  /** Разослать call:state всем участникам чата (gateway ретранслирует messenger.*) */
  async broadcastCallState(chatId: string, preloaded?: CallActiveDto | null): Promise<void> {
    // Вебхук-путь строит СВЕЖИЙ снимок (участник только что вошёл/вышел) и обновляет кэш.
    const built = await this.buildCallStatePayload(chatId, preloaded, { skipCache: true });
    if (!built) return;
    this.events.emit(
      'messenger.call.state',
      { ...built.payload, memberUserIds: built.memberUserIds },
      'messenger',
    );
  }

  /** Живые звонки моих чатов — watcher входящих при загрузке/reconnect любой страницы */
  async listMyActiveCalls(userId: string): Promise<ChatCallStatePayload[]> {
    // Перевёрнутый джойн (перф-ревью 2026-07-18): активных chat-сессий на платформе
    // единицы (partial-индекс), а чатов у активного юзера тысячи (контекстный чат на
    // каждую задачу/заказ) — раньше КАЖДЫЙ 12-секундный поллинг каждой вкладки сканировал
    // всё членство. Теперь типичный случай «звонков нет» = один индексный запрос → [].
    const activeRefIds = await this.calls.listActiveRefIds('chat');
    if (!activeRefIds.length) return [];
    const myChats = await this.db.chatMember.findMany({
      where: { userId, chatId: { in: activeRefIds } },
      select: { chatId: true },
    });
    if (!myChats.length) return [];
    const active = await this.calls.getActiveForRefs('chat', myChats.map((m) => m.chatId));
    if (!active.size) return [];
    const out: ChatCallStatePayload[] = [];
    for (const chatId of active.keys()) {
      const built = await this.buildCallStatePayload(chatId, active.get(chatId) ?? null);
      if (built) out.push(built.payload);
    }
    return out;
  }

  /** Отвязать и прибрать вложения всех attachment-сообщений чата (перед его удалением) */
  private async reapChatAttachments(chatId: string): Promise<void> {
    const msgs = await this.db.message.findMany({
      where: { chatId, type: 'attachment' },
      select: { id: true },
    });
    if (msgs.length) {
      await this.files.unlinkAllForRefs('chat_message', msgs.map((m) => m.id)).catch(() => undefined);
    }
  }

  private user(id: string): Principal {
    return { type: 'user', id };
  }

  private dmKeyOf(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private memberTuple(chatId: string, uid: string) {
    return {
      resourceType: 'chat',
      resourceId: chatId,
      relation: 'member',
      subjectType: 'user',
      subjectId: uid,
    };
  }

  // ============================================================
  // DM lifecycle
  // ============================================================
  async openDm(userId: string, peerId: string): Promise<ChatDetail> {
    if (peerId === userId) throw new BadRequestException('Нельзя начать диалог с самим собой');
    // DM is personal communication: unlike work artifacts (tasks/events/group
    // chats), it respects personal blocks even in a workspace context.
    await this.assertInEnvironment(userId, peerId, { alwaysCheckBlocks: true });

    const key = this.dmKeyOf(userId, peerId);
    let chat = await this.db.chat.findUnique({ where: { dmKey: key } });

    if (!chat) {
      try {
        // ATOMIC (see getOrCreateTaskChat): the DM row, its members and its access-membership
        // tuples commit together, so a concurrent opener / the P2002 loser never observes a
        // chat whose chat#member@user tuples aren't in yet (transient false 403 on chat.view).
        chat = await this.db.$transaction(async (tx) => {
          const c = await tx.chat.create({
            data: {
              type: 'dm',
              dmKey: key,
              members: { create: [{ userId }, { userId: peerId }] },
            },
          });
          await tx.relationTuple.createMany({
            data: [userId, peerId].map((uid) => ({
              resourceType: 'chat',
              resourceId: c.id,
              relation: 'member',
              subjectType: 'user',
              subjectId: uid,
              subjectRelation: '',
            })),
            skipDuplicates: true,
          });
          return c;
        });
      } catch (e: any) {
        // Concurrent open → unique(dmKey) race; re-read the winning row.
        if (e?.code === 'P2002') {
          chat = await this.db.chat.findUnique({ where: { dmKey: key } });
        } else {
          throw e;
        }
      }
    }
    if (!chat) throw new NotFoundException('Чат не найден');
    return this.getChatDetail(userId, chat.id);
  }

  /**
   * Both users must be in each other's Окружение (a ContactLink exists) and neither
   * may have blocked the other. Delegates to the shared gate in ContactsService —
   * the SAME rule now guards tasks/calendar/shop too (arch-review block 6).
   * In a workspace context the gate switches to co-membership («рабочий пропуск»);
   * `alwaysCheckBlocks` keeps personal blocks enforced there too (used for DM).
   */
  private async assertInEnvironment(
    userId: string,
    otherId: string,
    opts: { alwaysCheckBlocks?: boolean } = {},
  ): Promise<void> {
    await this.contacts.assertReachable(
      userId,
      [otherId],
      'Этого человека нет в вашем окружении',
      opts,
    );
  }

  // ============================================================
  // Access (engine is authoritative; ChatMember mirrors membership)
  // ============================================================
  private async assertAccess(userId: string, chatId: string): Promise<void> {
    const ok = await this.access.can(this.user(userId), 'chat.view', chatId);
    if (!ok) throw new ForbiddenException('Нет доступа к чату');
  }

  /**
   * Load the actor's ChatMember and assert manage rights on a GROUP chat.
   * ownerOnly → only the owner; otherwise owner or admin. Throws if the chat
   * is not a group (these ops are group-only).
   */
  private async assertManage(
    userId: string,
    chatId: string,
    opts?: { ownerOnly?: boolean },
  ): Promise<{
    chat: { id: string; type: string; lastSeq: number; title: string | null };
    role: ChatMemberRole;
  }> {
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { id: true, type: true, lastSeq: true, title: true },
    });
    if (!chat) throw new NotFoundException('Чат не найден');
    if (chat.type !== 'group') throw new BadRequestException('Операция доступна только для групп');

    const me = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { role: true, leftAt: true },
    });
    if (!me || me.leftAt) throw new ForbiddenException('Нет доступа к чату');
    const role = me.role as ChatMemberRole;
    if (opts?.ownerOnly) {
      if (role !== 'owner') throw new ForbiddenException('Только владелец может это сделать');
    } else if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Недостаточно прав');
    }
    return { chat, role };
  }

  // ============================================================
  // Group chats (ad-hoc, WhatsApp/Bitrix style)
  // ============================================================
  async createGroup(userId: string, name: string, memberIds: string[]): Promise<ChatDetail> {
    const members = [...new Set(memberIds)].filter((id) => id && id !== userId);
    for (const m of members) await this.assertInEnvironment(userId, m);

    const chat = await this.db.chat.create({
      data: {
        type: 'group',
        title: name,
        createdById: userId,
        members: {
          create: [
            { userId, role: 'owner', visibleFromSeq: 0 },
            ...members.map((id) => ({ userId: id, role: 'member', visibleFromSeq: 0 })),
          ],
        },
      },
    });

    await this.access.grantMany([
      this.memberTuple(chat.id, userId),
      ...members.map((id) => this.memberTuple(chat.id, id)),
    ]);

    const creator = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postSystemMessage(
      chat.id,
      'group.created',
      `${fullName(creator)} создал(а) группу «${name}»`,
    );

    return this.getChatDetail(userId, chat.id);
  }

  async renameGroup(userId: string, chatId: string, title: string): Promise<ChatDetail> {
    await this.assertManage(userId, chatId);
    await this.db.chat.update({ where: { id: chatId }, data: { title } });

    const actor = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postSystemMessage(
      chatId,
      'group.renamed',
      `${fullName(actor)} переименовал(а) группу в «${title}»`,
    );
    return this.getChatDetail(userId, chatId);
  }

  async addMembers(userId: string, chatId: string, userIds: string[]): Promise<ChatDetail> {
    const { chat } = await this.assertManage(userId, chatId);
    const candidates = [...new Set(userIds)].filter((id) => id && id !== userId);

    const added: string[] = [];
    for (const id of candidates) {
      await this.assertInEnvironment(userId, id);
      const existing = await this.db.chatMember.findUnique({
        where: { chatId_userId: { chatId, userId: id } },
        select: { id: true, leftAt: true },
      });
      if (existing && !existing.leftAt) continue; // already an active member
      // Product decision: added members see the FULL history (Bitrix/Slack-style),
      // so visibleFromSeq stays 0 — they are not limited to messages after they joined.
      if (existing) {
        // Re-join: clear leftAt; full history again.
        await this.db.chatMember.update({
          where: { id: existing.id },
          data: { role: 'member', leftAt: null, visibleFromSeq: 0 },
        });
      } else {
        await this.db.chatMember.create({
          data: { chatId, userId: id, role: 'member', visibleFromSeq: 0 },
        });
      }
      await this.access.grant(this.memberTuple(chatId, id));
      added.push(id);
    }

    if (added.length > 0) {
      const names = await this.namesOf(added);
      for (const id of added) {
        await this.postSystemMessage(
          chatId,
          'group.member_added',
          `${names.get(id) ?? 'Участник'} добавлен(а) в группу`,
        );
      }
    }
    return this.getChatDetail(userId, chatId);
  }

  async removeMember(userId: string, chatId: string, targetId: string): Promise<ChatDetail> {
    await this.assertManage(userId, chatId);
    const target = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: targetId } },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('Участник не найден');
    if (target.role === 'owner') throw new BadRequestException('Нельзя удалить владельца группы');

    await this.db.chatMember.delete({ where: { id: target.id } });
    // Instant Hard Revoke: drop the membership tuple.
    await this.access.revoke(this.memberTuple(chatId, targetId));

    const names = await this.namesOf([targetId]);
    await this.postSystemMessage(
      chatId,
      'group.member_removed',
      `${names.get(targetId) ?? 'Участник'} удалён(а) из группы`,
    );
    return this.getChatDetail(userId, chatId);
  }

  async leaveGroup(userId: string, chatId: string): Promise<void> {
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { type: true },
    });
    if (!chat) throw new NotFoundException('Чат не найден');
    if (chat.type !== 'group') throw new BadRequestException('Операция доступна только для групп');

    const me = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { id: true, role: true },
    });
    if (!me) throw new ForbiddenException('Вы не состоите в этой группе');
    if (me.role === 'owner') {
      throw new BadRequestException('Передайте права или удалите группу');
    }

    await this.db.chatMember.delete({ where: { id: me.id } });
    await this.access.revoke(this.memberTuple(chatId, userId));

    const actor = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postSystemMessage(
      chatId,
      'group.member_left',
      `${fullName(actor)} покинул(а) группу`,
    );
  }

  async setAdmin(
    userId: string,
    chatId: string,
    targetId: string,
    makeAdmin: boolean,
  ): Promise<ChatDetail> {
    await this.assertManage(userId, chatId, { ownerOnly: true });
    const target = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: targetId } },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('Участник не найден');
    if (target.role === 'owner') throw new BadRequestException('Владелец не может быть изменён');

    await this.db.chatMember.update({
      where: { id: target.id },
      data: { role: makeAdmin ? 'admin' : 'member' },
    });

    if (makeAdmin) {
      const names = await this.namesOf([targetId]);
      await this.postSystemMessage(
        chatId,
        'group.admin_granted',
        `${names.get(targetId) ?? 'Участник'} назначен(а) администратором`,
      );
    }
    return this.getChatDetail(userId, chatId);
  }

  async deleteGroup(userId: string, chatId: string): Promise<void> {
    await this.assertManage(userId, chatId, { ownerOnly: true });
    await this.reapChatAttachments(chatId); // вложения не каскадятся с cascade-удалением сообщений
    await this.access.revokeResource('chat', chatId);
    await this.db.chat.delete({ where: { id: chatId } }); // cascade members + messages
    await this.searchIndex.removeChat(chatId).catch(() => {}); // drop indexed messages
  }

  // ============================================================
  // Task (context) chats — replaces TaskComment
  // ============================================================

  /**
   * Find or create the chat for a task. NOTE: in practice the chat is created
   * EAGERLY — the first task.* lifecycle event (e.g. task.assigned) fires the
   * TaskSystemListener which calls postTaskSystemMessage → here — so by the time
   * anyone opens the task the chat + its first system plaque already exist. Opening
   * a task with no lifecycle event yet creates it on demand. Member access follows
   * the task's roles via usersets (chat#member@task#<role>), so a participant
   * removed from the task loses chat access automatically (Hard Revoke). ChatMember
   * rows are materialized for the inbox / read cursors.
   *
   * Concurrency: a unique([parentType,parentId]) constraint guarantees ONE chat per
   * task; concurrent callers race on create and the loser re-reads the winner (P2002).
   */
  private async getOrCreateTaskChat(
    taskId: string,
  ): Promise<{ id: string; type: string; lastSeq: number; title: string | null }> {
    const sel = { id: true, type: true, lastSeq: true, title: true } as const;
    const existing = await this.db.chat.findFirst({
      where: { parentType: 'task', parentId: taskId },
      select: sel,
    });
    if (existing) return existing;

    const task = await this.db.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        creatorId: true,
        participants: { select: { userId: true, role: true } },
      },
    });
    if (!task) throw new NotFoundException('Задача не найдена');

    // Engine: usersets bind chat membership to the task's roles (creator always + each
    // distinct participant role present). Materialized ChatMember rows mirror the same set.
    const roles = new Set<string>(['creator']);
    for (const p of task.participants) roles.add(p.role);
    const memberUserIds = new Set<string>([task.creatorId]);
    for (const p of task.participants) memberUserIds.add(p.userId);

    // ATOMIC creation: commit the chat row AND its access-membership tuples in ONE
    // transaction. Previously the row was committed first and the tuples granted in a
    // separate step; a concurrent reader (the eager TaskSystemListener racing the user's
    // own open — the window widens at cold start when queries are slow) could find the row
    // in that gap and see a chat with NO members → chat.view computed false → transient
    // false 403. Committing them together makes a findable chat ALWAYS grant its members.
    // The chat id is brand-new, so no cached check can reference it yet → no epoch bump
    // needed to invalidate anything (the old grantMany's chat-epoch bump is dropped).
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: { type: 'context', parentType: 'task', parentId: taskId, title: task.title },
          select: sel,
        });
        await tx.relationTuple.createMany({
          data: [...roles].map((relation) => ({
            resourceType: 'chat',
            resourceId: chat.id,
            relation: 'member',
            subjectType: 'task',
            subjectId: taskId,
            subjectRelation: relation,
          })),
          skipDuplicates: true,
        });
        await tx.chatMember.createMany({
          data: [...memberUserIds].map((uid) => ({
            chatId: chat.id,
            userId: uid,
            role: 'member',
            visibleFromSeq: 0,
          })),
          skipDuplicates: true,
        });
        return chat;
      });
    } catch (e: any) {
      // Concurrent create → unique(parentType,parentId) race; the loser re-reads the
      // winner's chat, which — being atomic — already carries its membership tuples.
      if (e?.code === 'P2002') {
        const won = await this.db.chat.findFirst({
          where: { parentType: 'task', parentId: taskId },
          select: sel,
        });
        if (won) return won;
      }
      throw e;
    }
  }

  /** Public: open the task's chat (verifying the user can view the task). */
  async getTaskChat(userId: string, taskId: string): Promise<ChatDetail> {
    const canView = await this.access.can(this.user(userId), 'task.view', taskId);
    if (!canView) throw new ForbiddenException('Нет доступа к задаче');
    const chat = await this.getOrCreateTaskChat(taskId);
    return this.getChatDetail(userId, chat.id);
  }

  /**
   * Reconcile a task chat's ChatMember rows to the current creator + participants.
   * Best-effort (never throws): the engine usersets already grant/revoke access via
   * the task#role tuples (resynced by AccessProjection), so we only keep the
   * materialized rows (inbox / cursors) in sync. Does NOT create the chat if absent.
   */
  async syncTaskChatMembers(taskId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'task', parentId: taskId },
        select: { id: true },
      });
      if (!chat) return;

      const task = await this.db.task.findUnique({
        where: { id: taskId },
        select: { creatorId: true, participants: { select: { userId: true } } },
      });
      if (!task) return;

      const desired = new Set<string>([task.creatorId]);
      for (const p of task.participants) desired.add(p.userId);

      const current = await this.db.chatMember.findMany({
        where: { chatId: chat.id },
        select: { userId: true },
      });
      const currentIds = new Set(current.map((m) => m.userId));

      const toAdd = [...desired].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !desired.has(id));

      if (toAdd.length) {
        await this.db.chatMember.createMany({
          data: toAdd.map((uid) => ({
            chatId: chat.id,
            userId: uid,
            role: 'member',
            visibleFromSeq: 0,
          })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length) {
        // Engine access already gone via resyncTaskRoles (task#role tuple removed);
        // just drop the now-stale materialized rows.
        await this.db.chatMember.deleteMany({
          where: { chatId: chat.id, userId: { in: toRemove } },
        });
      }
    } catch {
      // best-effort: never break the task operation
    }
  }

  /** Best-effort: delete the task's chat when the task is deleted. */
  async deleteTaskChat(taskId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'task', parentId: taskId },
        select: { id: true },
      });
      if (!chat) return;
      await this.reapChatAttachments(chat.id);
      await this.access.revokeResource('chat', chat.id);
      await this.db.chat.delete({ where: { id: chat.id } });
      await this.searchIndex.removeChat(chat.id); // drop indexed messages (best-effort: in try)
    } catch {
      // best-effort
    }
  }

  /**
   * Public: post a system message to a task's chat, ensuring the chat exists.
   * Used by the task-lifecycle listener (task.assigned / submitted / …).
   */
  async postTaskSystemMessage(
    taskId: string,
    eventType: SystemMessageEvent | string,
    text: string,
  ): Promise<void> {
    const chat = await this.getOrCreateTaskChat(taskId);
    await this.postSystemMessage(chat.id, eventType, text);
  }

  // ============================================================
  // Order (context) chats — mirrors task chats (buyer/seller/contributors)
  // ============================================================

  /**
   * Find or create the chat for an order. Members follow the order's roles via usersets
   * (chat#member@order:<id>#buyer|seller|contributor) so a contributor who withdraws loses
   * chat access automatically. ChatMember rows are materialized for the inbox / cursors.
   * A NORMAL (non-crowdfunding) order chat is created on demand (getOrderChat / the
   * 'listing.talk' DM path); the listener only creates it for funded campaigns + plaques.
   */
  private async getOrCreateOrderChat(
    orderId: string,
  ): Promise<{ id: string; type: string; lastSeq: number; title: string | null }> {
    const sel = { id: true, type: true, lastSeq: true, title: true } as const;
    const existing = await this.db.chat.findFirst({
      where: { parentType: 'order', parentId: orderId },
      select: sel,
    });
    if (existing) return existing;

    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: {
        titleSnapshot: true,
        buyerId: true,
        sellerId: true,
        contributions: { select: { contributorId: true } },
      },
    });
    if (!order) throw new NotFoundException('Заказ не найден');

    // Usersets: buyer + seller always; contributor only if any contributions exist.
    const contributorIds = [...new Set(order.contributions.map((c) => c.contributorId))];
    const relations = ['buyer', 'seller'];
    if (contributorIds.length) relations.push('contributor');
    const memberUserIds = new Set<string>([order.buyerId, order.sellerId, ...contributorIds]);

    // ATOMIC creation (see getOrCreateTaskChat): chat row + membership tuples + materialized
    // members in ONE transaction, so a concurrent reader never observes a member-less chat
    // (transient false 403 on chat.view). Fresh chat id → no epoch bump needed.
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: { type: 'context', parentType: 'order', parentId: orderId, title: order.titleSnapshot },
          select: sel,
        });
        await tx.relationTuple.createMany({
          data: relations.map((relation) => ({
            resourceType: 'chat',
            resourceId: chat.id,
            relation: 'member',
            subjectType: 'order',
            subjectId: orderId,
            subjectRelation: relation,
          })),
          skipDuplicates: true,
        });
        await tx.chatMember.createMany({
          data: [...memberUserIds].map((uid) => ({
            chatId: chat.id,
            userId: uid,
            role: 'member',
            visibleFromSeq: 0,
          })),
          skipDuplicates: true,
        });
        return chat;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const won = await this.db.chat.findFirst({
          where: { parentType: 'order', parentId: orderId },
          select: sel,
        });
        if (won) return won;
      }
      throw e;
    }
  }

  /** Public: open the order's chat (verifying the user can view the order). */
  async getOrderChat(userId: string, orderId: string): Promise<ChatDetail> {
    // Ensure the order's role tuples exist NOW (don't depend on the async shop.order.* listener).
    await this.accessProjection.resyncOrderRoles(orderId);
    const canView = await this.access.can(this.user(userId), 'order.view', orderId);
    if (!canView) throw new ForbiddenException('Нет доступа к заказу');
    const chat = await this.getOrCreateOrderChat(orderId);
    return this.getChatDetail(userId, chat.id);
  }

  /** Best-effort: reconcile an order chat's materialized members to buyer+seller+contributors. */
  async syncOrderChatMembers(orderId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'order', parentId: orderId },
        select: { id: true },
      });
      if (!chat) return;

      const order = await this.db.order.findUnique({
        where: { id: orderId },
        select: { buyerId: true, sellerId: true, contributions: { select: { contributorId: true } } },
      });
      if (!order) return;

      const desired = new Set<string>([
        order.buyerId,
        order.sellerId,
        ...order.contributions.map((c) => c.contributorId),
      ]);
      const current = await this.db.chatMember.findMany({
        where: { chatId: chat.id },
        select: { userId: true },
      });
      const currentIds = new Set(current.map((m) => m.userId));
      const toAdd = [...desired].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !desired.has(id));

      if (toAdd.length) {
        await this.db.chatMember.createMany({
          data: toAdd.map((uid) => ({ chatId: chat.id, userId: uid, role: 'member', visibleFromSeq: 0 })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length) {
        await this.db.chatMember.deleteMany({ where: { chatId: chat.id, userId: { in: toRemove } } });
      }
    } catch {
      // best-effort
    }
  }

  /** Best-effort: delete the order's chat when the order is gone. */
  async deleteOrderChat(orderId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'order', parentId: orderId },
        select: { id: true },
      });
      if (!chat) return;
      await this.reapChatAttachments(chat.id);
      await this.access.revokeResource('chat', chat.id);
      await this.db.chat.delete({ where: { id: chat.id } });
      await this.searchIndex.removeChat(chat.id); // drop indexed messages (best-effort: in try)
    } catch {
      // best-effort
    }
  }

  /** Public: post a system plaque to an order's chat, ensuring the chat exists. */
  async postOrderSystemMessage(
    orderId: string,
    eventType: SystemMessageEvent | string,
    text: string,
  ): Promise<void> {
    const chat = await this.getOrCreateOrderChat(orderId);
    await this.postSystemMessage(chat.id, eventType, text);
  }

  // ============================================================
  // Event (context) chats — mirrors task chats (organizer/attendees)
  // ============================================================

  /**
   * Find or create the chat for a calendar event. Members follow the event's roles via
   * usersets (chat#member@event:<id>#organizer|attendee); ChatMember rows are materialized
   * for the inbox / cursors. The master event row id is the anchor (parentId).
   */
  private async getOrCreateEventChat(
    eventId: string,
  ): Promise<{ id: string; type: string; lastSeq: number; title: string | null }> {
    const sel = { id: true, type: true, lastSeq: true, title: true } as const;
    const existing = await this.db.chat.findFirst({
      where: { parentType: 'event', parentId: eventId },
      select: sel,
    });
    if (existing) return existing;

    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      select: { title: true, userId: true, participants: { select: { userId: true } } },
    });
    if (!event) throw new NotFoundException('Событие не найдено');

    const attendeeIds = [...new Set(event.participants.map((p) => p.userId))].filter(
      (id) => id !== event.userId,
    );
    const relations = ['organizer'];
    if (attendeeIds.length) relations.push('attendee');
    const memberUserIds = new Set<string>([event.userId, ...attendeeIds]);

    // ATOMIC creation (see getOrCreateTaskChat): chat row + membership tuples + materialized
    // members in ONE transaction, so a concurrent reader never observes a member-less chat
    // (transient false 403 on chat.view). Fresh chat id → no epoch bump needed.
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: { type: 'context', parentType: 'event', parentId: eventId, title: event.title },
          select: sel,
        });
        await tx.relationTuple.createMany({
          data: relations.map((relation) => ({
            resourceType: 'chat',
            resourceId: chat.id,
            relation: 'member',
            subjectType: 'event',
            subjectId: eventId,
            subjectRelation: relation,
          })),
          skipDuplicates: true,
        });
        await tx.chatMember.createMany({
          data: [...memberUserIds].map((uid) => ({
            chatId: chat.id,
            userId: uid,
            role: 'member',
            visibleFromSeq: 0,
          })),
          skipDuplicates: true,
        });
        return chat;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const won = await this.db.chat.findFirst({
          where: { parentType: 'event', parentId: eventId },
          select: sel,
        });
        if (won) return won;
      }
      throw e;
    }
  }

  /** Public: open the event's chat (verifying the user can view the event). */
  async getEventChat(userId: string, eventId: string): Promise<ChatDetail> {
    // Ensure the event's role tuples exist NOW (don't depend on the async calendar.event.* listener).
    await this.accessProjection.resyncEventRoles(eventId);
    const canView = await this.access.can(this.user(userId), 'event.view', eventId);
    if (!canView) throw new ForbiddenException('Нет доступа к событию');
    const chat = await this.getOrCreateEventChat(eventId);
    return this.getChatDetail(userId, chat.id);
  }

  /** Best-effort: reconcile an event chat's materialized members to organizer+attendees. */
  async syncEventChatMembers(eventId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'event', parentId: eventId },
        select: { id: true },
      });
      if (!chat) return;

      const event = await this.db.calendarEvent.findUnique({
        where: { id: eventId },
        select: { userId: true, participants: { select: { userId: true } } },
      });
      if (!event) return;

      const desired = new Set<string>([event.userId, ...event.participants.map((p) => p.userId)]);
      const current = await this.db.chatMember.findMany({
        where: { chatId: chat.id },
        select: { userId: true },
      });
      const currentIds = new Set(current.map((m) => m.userId));
      const toAdd = [...desired].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !desired.has(id));

      if (toAdd.length) {
        await this.db.chatMember.createMany({
          data: toAdd.map((uid) => ({ chatId: chat.id, userId: uid, role: 'member', visibleFromSeq: 0 })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length) {
        await this.db.chatMember.deleteMany({ where: { chatId: chat.id, userId: { in: toRemove } } });
      }
    } catch {
      // best-effort
    }
  }

  /** Best-effort: delete the event's chat when the event is gone. */
  async deleteEventChat(eventId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'event', parentId: eventId },
        select: { id: true },
      });
      if (!chat) return;
      await this.reapChatAttachments(chat.id);
      await this.access.revokeResource('chat', chat.id);
      await this.db.chat.delete({ where: { id: chat.id } });
      await this.searchIndex.removeChat(chat.id); // drop indexed messages (best-effort: in try)
    } catch {
      // best-effort
    }
  }

  /** Public: post a system plaque to an event's chat, ensuring the chat exists. */
  async postEventSystemMessage(
    eventId: string,
    eventType: SystemMessageEvent | string,
    text: string,
  ): Promise<void> {
    const chat = await this.getOrCreateEventChat(eventId);
    await this.postSystemMessage(chat.id, eventType, text);
  }

  // ============================================================
  // Office-room (context) chats — чат встречи «Виртуального офиса» (host/participant).
  // Чат живёт и ПОСЛЕ завершения встречи — история переписки остаётся участникам.
  // ============================================================

  /**
   * Find or create the chat for an office meeting. Members follow the room's roles via
   * usersets (chat#member@office_room:<id>#host|participant); ChatMember rows are
   * materialized for the inbox / cursors.
   */
  private async getOrCreateOfficeRoomChat(
    roomId: string,
  ): Promise<{ id: string; type: string; lastSeq: number; title: string | null }> {
    const sel = { id: true, type: true, lastSeq: true, title: true } as const;
    const existing = await this.db.chat.findFirst({
      where: { parentType: 'office_room', parentId: roomId },
      select: sel,
    });
    if (existing) return existing;

    const room = await this.db.officeRoom.findUnique({
      where: { id: roomId },
      select: { name: true, participants: { select: { userId: true } } },
    });
    if (!room) throw new NotFoundException('Встреча не найдена');

    const memberUserIds = new Set<string>(room.participants.map((p) => p.userId));

    // ATOMIC creation (see getOrCreateTaskChat): chat row + membership tuples + materialized
    // members in ONE transaction, so a concurrent reader never observes a member-less chat.
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: { type: 'context', parentType: 'office_room', parentId: roomId, title: room.name },
          select: sel,
        });
        await tx.relationTuple.createMany({
          data: ['host', 'participant'].map((relation) => ({
            resourceType: 'chat',
            resourceId: chat.id,
            relation: 'member',
            subjectType: 'office_room',
            subjectId: roomId,
            subjectRelation: relation,
          })),
          skipDuplicates: true,
        });
        await tx.chatMember.createMany({
          data: [...memberUserIds].map((uid) => ({
            chatId: chat.id,
            userId: uid,
            role: 'member',
            visibleFromSeq: 0,
          })),
          skipDuplicates: true,
        });
        return chat;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const won = await this.db.chat.findFirst({
          where: { parentType: 'office_room', parentId: roomId },
          select: sel,
        });
        if (won) return won;
      }
      throw e;
    }
  }

  /** Public: open the meeting's chat (verifying the user can view the office room). */
  async getOfficeRoomChat(userId: string, roomId: string): Promise<ChatDetail> {
    // Ensure the room's role tuples exist NOW (don't depend on the async office.* listener).
    await this.accessProjection.resyncOfficeRoomRoles(roomId);
    const canView = await this.access.can(this.user(userId), 'office_room.view', roomId);
    if (!canView) throw new ForbiddenException('Нет доступа к встрече');
    const chat = await this.getOrCreateOfficeRoomChat(roomId);
    return this.getChatDetail(userId, chat.id);
  }

  /** Best-effort: reconcile the meeting chat's materialized members to the room's participants. */
  async syncOfficeRoomChatMembers(roomId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'office_room', parentId: roomId },
        select: { id: true },
      });
      if (!chat) return;

      const room = await this.db.officeRoom.findUnique({
        where: { id: roomId },
        select: { participants: { select: { userId: true } } },
      });
      if (!room) return;

      const desired = new Set<string>(room.participants.map((p) => p.userId));
      const current = await this.db.chatMember.findMany({
        where: { chatId: chat.id },
        select: { userId: true },
      });
      const currentIds = new Set(current.map((m) => m.userId));
      const toAdd = [...desired].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !desired.has(id));

      if (toAdd.length) {
        await this.db.chatMember.createMany({
          data: toAdd.map((uid) => ({ chatId: chat.id, userId: uid, role: 'member', visibleFromSeq: 0 })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length) {
        await this.db.chatMember.deleteMany({ where: { chatId: chat.id, userId: { in: toRemove } } });
      }
    } catch {
      // best-effort
    }
  }

  /** Best-effort: delete the meeting's chat (задел — v1 встречу не удаляет, только завершает). */
  async deleteOfficeRoomChat(roomId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'office_room', parentId: roomId },
        select: { id: true },
      });
      if (!chat) return;
      await this.reapChatAttachments(chat.id);
      await this.access.revokeResource('chat', chat.id);
      await this.db.chat.delete({ where: { id: chat.id } });
      await this.searchIndex.removeChat(chat.id);
    } catch {
      // best-effort
    }
  }

  /** Public: post a system plaque to a meeting's chat, ensuring the chat exists. */
  async postOfficeRoomSystemMessage(
    roomId: string,
    eventType: SystemMessageEvent | string,
    text: string,
  ): Promise<void> {
    const chat = await this.getOrCreateOfficeRoomChat(roomId);
    await this.postSystemMessage(chat.id, eventType, text);
  }

  /** Public: плашка прямо в чат по id (итоги звонков — ChatCallsListener). */
  async postChatSystemMessage(
    chatId: string,
    eventType: SystemMessageEvent | string,
    text: string,
  ): Promise<void> {
    await this.postSystemMessage(chatId, eventType, text);
  }

  // ============================================================
  // Rich cards (Phase 3) — a service-posted interactive card message
  // ============================================================

  /**
   * Post a rich_card message into a chat. Called by RichCardsService.shareToChat (which has
   * already verified the actor can view both the chat and the entity). Assigns the next per-chat
   * seq like sendMessage and broadcasts messenger.message.created so live clients render it.
   */
  async postRichCard(
    chatId: string,
    payload: RichCardPayload,
    authorId: string,
  ): Promise<ChatMessage> {
    const { msg, chatType } = await this.db.$transaction(async (tx) => {
      const chat = await tx.chat.update({
        where: { id: chatId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true, type: true },
      });
      const seq = chat.lastSeq;
      const created = await tx.message.create({
        data: {
          chatId,
          authorId,
          type: 'rich_card',
          content: null,
          payload: payload as unknown as Prisma.InputJsonValue,
          seq,
        },
        include: { author: { select: USER_LITE } },
      });
      await tx.chatMember.updateMany({
        where: { chatId, userId: authorId },
        data: { lastReadSeq: seq, deliveredSeq: seq, lastReadAt: new Date(), deliveredAt: new Date() },
      });
      return { msg: created, chatType: chat.type };
    });

    const memberUserIds = await this.memberIds(chatId);
    const recipientIds = memberUserIds.filter((id) => id !== authorId);
    this.events.emit(
      'messenger.message.created',
      {
        chatId,
        message: this.toMessage(msg, '__broadcast__'),
        memberUserIds,
        recipientIds,
        authorName: fullName(msg.author),
        chatType,
        preview: this.toPreview(msg).text,
      },
      'messenger',
    );

    return this.toMessage(msg, authorId, 0, 0, undefined, chatType === 'dm');
  }

  // ============================================================
  // System messages
  // ============================================================
  private async postSystemMessage(
    chatId: string,
    eventType: SystemMessageEvent | string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const msg = await this.db.$transaction(async (tx) => {
      const chat = await tx.chat.update({
        where: { id: chatId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      return tx.message.create({
        data: {
          chatId,
          authorId: null,
          type: 'system',
          content: null,
          payload: { eventType, text, ...extra },
          seq: chat.lastSeq,
        },
        include: { author: { select: USER_LITE } },
      });
    });

    const memberUserIds = await this.memberIds(chatId);
    this.events.emit(
      'messenger.message.created',
      {
        chatId,
        message: this.toMessage(msg, '__system__'),
        memberUserIds,
        // No recipientIds / notification fan-out: system plaques are silent.
        isSystem: true,
      },
      'messenger',
    );
  }

  // ============================================================
  // Inbox
  // ============================================================
  async listChats(userId: string): Promise<ChatSummary[]> {
    const memberships = await this.db.chatMember.findMany({
      where: { userId, archived: false, leftAt: null },
      include: {
        chat: {
          include: {
            // ONLY the DM peer (groups don't render member lists in the inbox) — the
            // previous include pulled EVERY member of EVERY chat with full user rows
            // (50 groups × 50 members = 2500 joined rows per inbox load).
            members: {
              where: { leftAt: null, userId: { not: userId } },
              take: 1,
              select: { userId: true, user: { select: USER_LITE } },
            },
            _count: { select: { members: { where: { leftAt: null } } } },
            messages: {
              orderBy: { seq: 'desc' },
              take: 1,
              include: { author: { select: USER_LITE } },
            },
          },
        },
      },
    });

    // Visible chats: those with a last message (or pinned). Empty DMs stay hidden.
    // A fresh group/context chat always has its 'created' system message, so it shows.
    const visible = memberships.filter((m) => m.chat.messages[0] || m.pinned);

    // Unread per chat in ONE indexed range query (seq > cursor) — NOT a scan of the
    // full history (the old groupBy counted every message of every chat ever).
    const unreadByChat = await this.computeUnread(userId, visible.map((m) => m.chatId));

    // Живые созвоны батчем (баннер «Идёт звонок» в инбоксе) — движок читает свои таблицы сам
    const activeCalls = await this.calls.getActiveForRefs('chat', visible.map((m) => m.chatId));

    const summaries: ChatSummary[] = visible.map((m) => {
      const chat = m.chat;
      const last = chat.messages[0] ?? null;
      const peerMember = chat.type === 'dm' ? chat.members[0] : null;
      const peer = peerMember?.user ?? null;

      return {
        id: chat.id,
        type: chat.type as ChatSummary['type'],
        title: peer ? fullName(peer) : chat.title ?? 'Чат',
        avatar: peer?.avatar ?? null,
        peerUserId: peer?.id ?? null,
        parentType: (chat.parentType as ChatSummary['parentType']) ?? null,
        parentId: chat.parentId ?? null,
        memberCount: chat.type === 'dm' ? null : chat._count.members,
        myRole: (m.role as ChatMemberRole) ?? 'member',
        lastMessage: last ? this.toPreview(last) : null,
        unreadCount: unreadByChat.get(chat.id) ?? 0,
        muted: m.mutedUntil ? m.mutedUntil > new Date() : false,
        pinned: m.pinned,
        updatedAt: (last?.createdAt ?? chat.updatedAt).toISOString(),
        activeCall: activeCalls.get(chat.id) ?? null,
      };
    });

    return summaries.sort((x, y) => {
      if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
      return y.updatedAt.localeCompare(x.updatedAt);
    });
  }

  /**
   * Unread counts for many chats in ONE raw query whose work is O(unread), not O(history):
   * the (chatId, seq) index serves `seq > cursor` as a range scan per chat. Respects the
   * member's visibility floor (visibleFromSeq — group members don't "unread" pre-join
   * history) and excludes own + system + deleted messages.
   */
  private async computeUnread(userId: string, chatIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!chatIds.length) return result;

    const rows = await this.db.$queryRaw<Array<{ chatId: string; unread: number }>>(Prisma.sql`
      SELECT m.chat_id AS "chatId", COUNT(*)::int AS unread
      FROM messages m
      JOIN chat_members cm
        ON cm.chat_id = m.chat_id AND cm.user_id = ${userId} AND cm.left_at IS NULL
      WHERE m.chat_id IN (${Prisma.join(chatIds)})
        AND m.deleted_at IS NULL
        AND m.type <> 'system'
        AND m.author_id <> ${userId}
        AND m.seq > GREATEST(cm.last_read_seq, cm.visible_from_seq - 1)
      GROUP BY m.chat_id
    `);
    for (const r of rows) result.set(r.chatId, r.unread);
    return result;
  }

  // ============================================================
  // Chat detail + messages
  // ============================================================
  async getChatDetail(userId: string, chatId: string): Promise<ChatDetail> {
    await this.assertAccess(userId, chatId);
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      include: { members: { include: { user: { select: USER_LITE } } } },
    });
    if (!chat) throw new NotFoundException('Чат не найден');

    const activeMembers = chat.members.filter((m) => !m.leftAt);
    const me = chat.members.find((m) => m.userId === userId);
    const peerMember =
      chat.type === 'dm' ? activeMembers.find((m) => m.userId !== userId) : null;
    const peer = peerMember?.user ?? null;

    // Role tags per chat type (group: my contact label for them; task: their task role).
    const otherIds = activeMembers.filter((m) => m.userId !== userId).map((m) => m.userId);
    let labelMap: Map<string, string | null>;
    if (chat.type === 'group') {
      labelMap = await this.contacts.resolveLabels(userId, otherIds);
    } else if (chat.type === 'context' && chat.parentType === 'task' && chat.parentId) {
      labelMap = await this.taskRoleLabels(chat.parentId);
    } else if (chat.type === 'context' && chat.parentType === 'order' && chat.parentId) {
      labelMap = await this.orderRoleLabels(chat.parentId);
    } else if (chat.type === 'context' && chat.parentType === 'event' && chat.parentId) {
      labelMap = await this.eventRoleLabels(chat.parentId);
    } else if (chat.type === 'context' && chat.parentType === 'office_room' && chat.parentId) {
      labelMap = await this.officeRoomRoleLabels(chat.parentId);
    } else {
      labelMap = new Map();
    }

    const participants: ChatParticipantInfo[] = activeMembers.map((m) => ({
      userId: m.userId,
      name: fullName(m.user),
      avatar: m.user.avatar,
      role: m.role as ChatMemberRole,
      roleTag: labelMap.get(m.userId) ?? null,
      deliveredSeq: m.deliveredSeq,
      lastReadSeq: m.lastReadSeq,
    }));

    return {
      id: chat.id,
      type: chat.type as ChatDetail['type'],
      title: peer ? fullName(peer) : chat.title ?? 'Чат',
      avatar: peer?.avatar ?? null,
      peerUserId: peer?.id ?? null,
      parentType: (chat.parentType as ChatDetail['parentType']) ?? null,
      parentId: chat.parentId ?? null,
      createdById: chat.createdById ?? null,
      myRole: (me?.role as ChatMemberRole) ?? 'member',
      participants,
      myLastReadSeq: me?.lastReadSeq ?? 0,
      muted: me?.mutedUntil ? me.mutedUntil > new Date() : false,
      pinned: me?.pinned ?? false,
      activeCall: (await this.calls.getActiveForRefs('chat', [chatId])).get(chatId) ?? null,
    };
  }

  async getMessages(
    userId: string,
    chatId: string,
    beforeSeq?: number,
    limit = MESSENGER_LIMITS.messagePageSize,
  ): Promise<ChatMessage[]> {
    await this.assertAccess(userId, chatId);
    const take = Math.min(Math.max(limit, 1), 100);

    // Only show messages from when I joined (group re-joins see history from join).
    const me = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { visibleFromSeq: true },
    });
    const visibleFrom = me?.visibleFromSeq ?? 0;

    const rows = await this.db.message.findMany({
      where: {
        chatId,
        seq: { gt: visibleFrom, ...(beforeSeq ? { lt: beforeSeq } : {}) },
      },
      orderBy: { seq: 'desc' },
      take,
      include: MESSAGE_REPLY_INCLUDE,
    });

    // Resolve author role tags for group/task chats (batch, no N+1).
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { type: true, parentType: true, parentId: true },
    });

    // Delivery ticks (sent/delivered/read) are a DM-only feature: in a 1:1 chat the
    // peer's cursor is unambiguous. In groups a min-over-all-members aggregate is
    // misleading (and resets to "sent" whenever a new member with cursor 0 joins),
    // so we show no ticks there — same as Telegram.
    let minDelivered = 0;
    let minRead = 0;
    if (chat?.type === 'dm') {
      const members = await this.db.chatMember.findMany({
        where: { chatId, leftAt: null },
        select: { userId: true, deliveredSeq: true, lastReadSeq: true },
      });
      const peers = members.filter((m) => m.userId !== userId);
      minDelivered = peers.length ? Math.min(...peers.map((p) => p.deliveredSeq)) : 0;
      minRead = peers.length ? Math.min(...peers.map((p) => p.lastReadSeq)) : 0;
    }
    const authorIds = [
      ...new Set(rows.map((r) => r.authorId).filter((id): id is string => !!id)),
    ];
    let labelMap: Map<string, string | null> = new Map();
    if (chat?.type === 'group') {
      labelMap = await this.contacts.resolveLabels(userId, authorIds);
    } else if (chat?.type === 'context' && chat.parentType === 'task' && chat.parentId) {
      labelMap = await this.taskRoleLabels(chat.parentId);
    } else if (chat?.type === 'context' && chat.parentType === 'order' && chat.parentId) {
      labelMap = await this.orderRoleLabels(chat.parentId);
    } else if (chat?.type === 'context' && chat.parentType === 'event' && chat.parentId) {
      labelMap = await this.eventRoleLabels(chat.parentId);
    } else if (chat?.type === 'context' && chat.parentType === 'office_room' && chat.parentId) {
      labelMap = await this.officeRoomRoleLabels(chat.parentId);
    }

    const showStatus = chat?.type === 'dm';
    // Обогащение вложений подписанными ссылками БАТЧЕМ (один findMany + HMAC-подпись):
    // раньше каждая плитка делала 2 HTTP × 4–5 запросов БД (meta+download), а лента с
    // 30 медиа = ~60 запросов, пробивавших short-троттлер в prod (перф-ревью 2026-07-18).
    await this.attachViewsTo(rows);
    return rows
      .reverse()
      .map((r) => this.toMessage(r, userId, minDelivered, minRead, labelMap, showStatus));
  }

  /**
   * Дописать attachment-сообщениям `files[].view` (ссылки+мета) — НЕ сохраняется в БД,
   * только в отдаваемый DTO. Best-effort: сбой обогащения не ломает ленту (клиент
   * имеет фолбэк через GET /files/:id/download).
   */
  private async attachViewsTo(
    rows: Array<{ type: string; deletedAt?: Date | null; payload: unknown }>,
  ): Promise<void> {
    const attach = rows.filter(
      (r) => r.type === 'attachment' && !r.deletedAt && r.payload && typeof r.payload === 'object',
    );
    if (!attach.length) return;
    const ids: string[] = [];
    for (const r of attach) {
      for (const f of (r.payload as { files?: Array<{ fileId?: string }> }).files ?? []) {
        if (f?.fileId) ids.push(f.fileId);
      }
    }
    if (!ids.length) return;
    try {
      const views = await this.files.buildAttachmentViews(ids);
      if (!views.size) return;
      for (const r of attach) {
        for (const f of (r.payload as { files?: Array<{ fileId?: string; view?: unknown }> }).files ?? []) {
          const v = f?.fileId ? views.get(f.fileId) : undefined;
          if (v) f.view = v;
        }
      }
    } catch {
      /* best-effort */
    }
  }

  // ============================================================
  // Send / edit / delete
  // ============================================================
  /** Цитата (Phase 7): только сообщение из ЭТОГО чата */
  private async assertReplyInChat(chatId: string, replyToId?: string): Promise<void> {
    if (!replyToId) return;
    const parent = await this.db.message.findUnique({
      where: { id: replyToId },
      select: { chatId: true },
    });
    if (!parent || parent.chatId !== chatId) {
      throw new BadRequestException('Можно цитировать только сообщение из этого чата');
    }
  }

  /**
   * Общий хвост отправки (text и attachment): транзакция (seq → message.create →
   * линковка файлов → own-cursor) + fan-out на шину. Файлы линкуются ЗДЕСЬ же —
   * сообщение и его вложения атомарны (модель эскроу Задачника).
   */
  private async persistAndFanout(
    userId: string,
    chatId: string,
    data: {
      type: 'text' | 'attachment';
      content: string | null;
      payload?: Prisma.InputJsonValue;
      replyToId?: string | null;
      fileIds?: string[];
    },
  ): Promise<{ msg: Prisma.MessageGetPayload<{ include: typeof MESSAGE_REPLY_INCLUDE }>; chatType: string }> {
    const { msg, chatType } = await this.db.$transaction(async (tx) => {
      // Assign the next per-chat seq (atomic increment under the row).
      const chat = await tx.chat.update({
        where: { id: chatId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true, type: true },
      });
      const seq = chat.lastSeq;
      const created = await tx.message.create({
        data: {
          chatId,
          authorId: userId,
          type: data.type,
          content: data.content,
          payload: data.payload,
          seq,
          replyToId: data.replyToId ?? null,
        },
        include: MESSAGE_REPLY_INCLUDE,
      });
      if (data.fileIds?.length) {
        await this.files.linkManyInTx(tx, userId, data.fileIds, 'chat_message', created.id);
      }
      // Author implicitly read & received their own message.
      await tx.chatMember.updateMany({
        where: { chatId, userId },
        data: {
          lastReadSeq: seq,
          deliveredSeq: seq,
          lastReadAt: new Date(),
          deliveredAt: new Date(),
        },
      });
      return { msg: created, chatType: chat.type };
    });

    const memberUserIds = await this.memberIds(chatId);
    const recipientIds = memberUserIds.filter((id) => id !== userId);

    this.events.emit(
      'messenger.message.created',
      {
        chatId,
        message: this.toMessage(msg, '__broadcast__'),
        memberUserIds,
        recipientIds,
        authorName: fullName(msg.author),
        chatType,
        preview: this.toPreview(msg).text,
      },
      'messenger',
    );
    return { msg, chatType };
  }

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    replyToId?: string,
  ): Promise<ChatMessage> {
    await this.assertAccess(userId, chatId);
    await this.assertReplyInChat(chatId, replyToId);

    const { msg, chatType } = await this.persistAndFanout(userId, chatId, {
      type: 'text',
      content,
      replyToId: replyToId ?? null,
    });

    // Mentions Hub (Phase 5): record @mentions + ping the mentioned people. Best-effort
    // (MentionsService swallows errors); the extra guard ensures a throw can't break send.
    try {
      await this.mentions.recordMessageMentions({
        content,
        chatId,
        messageId: msg.id,
        authorId: userId,
        chatType,
      });
    } catch {
      // never break sendMessage on a mention failure
    }

    // Search index (Phase 6): fire-and-forget — upsert с пересчётом tsvector стоял в
    // критическом пути send (~20–30% латентности); секунда лага поиска незаметна, а
    // потерю (краш между send и индексом) добирает крон-сверка reconcileRecentMessages.
    void this.searchIndex
      .indexMessage({
        id: msg.id,
        chatId,
        authorId: userId,
        content,
        seq: msg.seq,
        type: 'text',
        createdAt: msg.createdAt,
      })
      .catch(() => undefined);

    return this.toMessage(msg, userId, 0, 0, undefined, chatType === 'dm');
  }

  /**
   * Ф9 (вложения): альбом до 10 файлов + подпись. Подпись живёт в content (К-1) —
   * правки/упоминания/поиск работают как у текста. Файлы линкуются в транзакции
   * сообщения (refType='chat_message'), доступ собеседников — через резолвер.
   */
  async sendAttachmentMessage(
    userId: string,
    chatId: string,
    fileIds: string[],
    caption?: string,
    replyToId?: string,
  ): Promise<ChatMessage> {
    await this.assertAccess(userId, chatId);
    await this.assertReplyInChat(chatId, replyToId);

    // Предвалидация ДО транзакции: файлы готовы и принадлежат отправителю (движок → 400)
    const files = await this.files.getOwnedReadyFiles(userId, fileIds);
    const payload: AttachmentsPayload = {
      kind: 'attachments',
      files: files.map((f) => ({ fileId: f.id, name: f.name, kind: f.kind, size: f.size, mime: f.mime, profile: f.profile })),
    };
    const content = caption?.trim() ? caption.trim() : null;

    const { msg, chatType } = await this.persistAndFanout(userId, chatId, {
      type: 'attachment',
      content,
      payload: payload as unknown as Prisma.InputJsonValue,
      replyToId: replyToId ?? null,
      fileIds: files.map((f) => f.id),
    });

    if (content) {
      try {
        await this.mentions.recordMessageMentions({
          content,
          chatId,
          messageId: msg.id,
          authorId: userId,
          chatType,
        });
      } catch {
        // never break send on a mention failure
      }
      // Fire-and-forget (см. sendMessage): индекс вне критического пути send.
      void this.searchIndex
        .indexMessage({
          id: msg.id,
          chatId,
          authorId: userId,
          content,
          seq: msg.seq,
          type: 'attachment',
          createdAt: msg.createdAt,
        })
        .catch(() => undefined);
    }

    // Эхо отправителю сразу со ссылками (альбом только что залит — рендер без 2×N HTTP).
    await this.attachViewsTo([msg]);
    return this.toMessage(msg, userId, 0, 0, undefined, chatType === 'dm');
  }

  async editMessage(userId: string, messageId: string, content: string): Promise<ChatMessage> {
    const msg = await this.db.message.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    // Access first: a user removed from the chat (Hard Revoke) loses edit rights even
    // on their own old messages. Authorship alone is not enough.
    await this.assertAccess(userId, msg.chatId);
    if (msg.authorId !== userId) throw new ForbiddenException('Можно редактировать только свои сообщения');
    if (msg.deletedAt) throw new BadRequestException('Сообщение удалено');
    // attachment: редактируется только подпись (она и живёт в content — К-1)
    if (msg.type !== 'text' && msg.type !== 'attachment') {
      throw new BadRequestException('Это сообщение нельзя редактировать');
    }

    const updated = await this.db.message.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: MESSAGE_REPLY_INCLUDE,
    });
    await this.broadcastUpdate(updated, 'messenger.message.updated');

    // Mentions Hub (Phase 5): re-parse the NEW content. The unique [messageId,user]
    // constraint + new-only notify means existing mentions don't duplicate/re-notify,
    // while a person newly @-named in the edit IS recorded and notified. Best-effort.
    try {
      await this.mentions.recordMessageMentions({
        content,
        chatId: updated.chatId,
        messageId: updated.id,
        authorId: userId,
        chatType: 'text',
      });
    } catch {
      // never break editMessage on a mention failure
    }

    // Search index (Phase 6): re-index the edited text. Best-effort.
    try {
      await this.searchIndex.indexMessage({
        id: updated.id,
        chatId: updated.chatId,
        authorId: updated.authorId,
        content: updated.content,
        seq: updated.seq,
        type: updated.type,
        createdAt: updated.createdAt,
        deletedAt: updated.deletedAt,
      });
    } catch {
      // never break editMessage on an index failure
    }

    return this.toMessage(updated, userId);
  }

  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const msg = await this.db.message.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Сообщение не найдено');
    // Access first (see editMessage): removal from the chat revokes delete rights too.
    await this.assertAccess(userId, msg.chatId);
    if (msg.authorId !== userId) throw new ForbiddenException('Можно удалять только свои сообщения');
    if (msg.deletedAt) return;

    const updated = await this.db.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: null },
      include: { author: { select: USER_LITE } },
    });
    await this.broadcastUpdate(updated, 'messenger.message.deleted');

    // Ф9: файлы attachment-сообщения умирают вместе с ним (Telegram-модель) — связи
    // снимаются, осиротевшие файлы soft-delete'ятся движком (квота не копит невидимое;
    // файл, привязанный ещё где-то — напр. переслан, — живёт). Окно краша подстрахует
    // крон-свип осиротевших ready-файлов. Best-effort.
    if (msg.type === 'attachment') {
      await this.files.unlinkAllForRef('chat_message', messageId).catch(() => undefined);
    }

    // Search index (Phase 6): drop the deleted message from the index. Best-effort.
    try {
      await this.searchIndex.removeMessage(messageId);
    } catch {
      // never break deleteMessage on an index failure
    }
  }

  // ============================================================
  // Read / delivery cursors
  // ============================================================
  async markDelivered(userId: string, chatId: string, seq: number): Promise<void> {
    // Membership is the gate: a non-member has no ChatMember row → no-op. The engine
    // check is implicit here (delivery is low-stakes); read/post go through assertAccess.
    const m = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      include: { chat: { select: { lastSeq: true } } },
    });
    if (!m || m.leftAt) return;
    // Clamp to the chat's real lastSeq: an arbitrary client seq must not run the cursor
    // ahead of messages that don't exist yet ("read" ticks on unsent messages).
    const clamped = Math.min(seq, m.chat.lastSeq);
    if (clamped <= m.deliveredSeq) return;
    await this.db.chatMember.update({
      where: { id: m.id },
      data: { deliveredSeq: clamped, deliveredAt: new Date() },
    });
    await this.emitReceipt(chatId, userId, clamped, m.lastReadSeq);
  }

  async markRead(userId: string, chatId: string, seq: number): Promise<void> {
    await this.assertAccess(userId, chatId);
    const m = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      include: { chat: { select: { lastSeq: true } } },
    });
    if (!m) return;
    const clamped = Math.min(seq, m.chat.lastSeq); // see markDelivered
    const newRead = Math.max(m.lastReadSeq, clamped);
    const newDelivered = Math.max(m.deliveredSeq, newRead);
    if (newRead === m.lastReadSeq && newDelivered === m.deliveredSeq) return;
    await this.db.chatMember.update({
      where: { id: m.id },
      data: {
        lastReadSeq: newRead,
        lastReadAt: new Date(),
        deliveredSeq: newDelivered,
        deliveredAt: new Date(),
      },
    });
    await this.emitReceipt(chatId, userId, newDelivered, newRead);
  }

  // ============================================================
  // Typing relay support (Phase 4)
  // ============================================================

  /**
   * For the transient typing relay: verify the user may view the chat (engine), then
   * return the OTHER active members' user ids (to fan a typing event to their rooms).
   * Returns null if the user has no access (caller silently ignores). No DB writes.
   */
  async typingAudience(userId: string, chatId: string): Promise<string[] | null> {
    const ok = await this.access.can(this.user(userId), 'chat.view', chatId);
    if (!ok) return null;
    const members = await this.memberIds(chatId);
    return members.filter((id) => id !== userId);
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async memberIds(chatId: string): Promise<string[]> {
    const members = await this.db.chatMember.findMany({
      where: { chatId, leftAt: null },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /** Display names for a set of user ids (one query). */
  private async namesOf(userIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userIds.length === 0) return map;
    const users = await this.db.user.findMany({
      where: { id: { in: userIds } },
      select: USER_LITE,
    });
    for (const u of users) map.set(u.id, fullName(u));
    return map;
  }

  /** userId → Russian task-role label, for a task (context) chat. */
  private async taskRoleLabels(taskId: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      select: { creatorId: true, participants: { select: { userId: true, role: true } } },
    });
    if (!task) return map;
    map.set(task.creatorId, TASK_ROLE_LABELS.creator);
    for (const p of task.participants) {
      // Creator label wins if the creator is also a participant.
      if (map.has(p.userId)) continue;
      map.set(p.userId, TASK_ROLE_LABELS[p.role] ?? null);
    }
    return map;
  }

  /** userId → Russian order-role label, for an order (context) chat. */
  private async orderRoleLabels(orderId: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: { buyerId: true, sellerId: true, contributions: { select: { contributorId: true } } },
    });
    if (!order) return map;
    // Seller label wins, then buyer, then contributor (a person may hold several roles).
    map.set(order.sellerId, ORDER_ROLE_LABELS.seller);
    if (!map.has(order.buyerId)) map.set(order.buyerId, ORDER_ROLE_LABELS.buyer);
    for (const c of order.contributions) {
      if (map.has(c.contributorId)) continue;
      map.set(c.contributorId, ORDER_ROLE_LABELS.contributor);
    }
    return map;
  }

  /** userId → Russian event-role label, for an event (context) chat. */
  private async eventRoleLabels(eventId: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId },
      select: { userId: true, participants: { select: { userId: true } } },
    });
    if (!event) return map;
    map.set(event.userId, EVENT_ROLE_LABELS.organizer);
    for (const p of event.participants) {
      if (map.has(p.userId)) continue;
      map.set(p.userId, EVENT_ROLE_LABELS.attendee);
    }
    return map;
  }

  private async officeRoomRoleLabels(roomId: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const room = await this.db.officeRoom.findUnique({
      where: { id: roomId },
      select: { participants: { select: { userId: true, role: true } } },
    });
    if (!room) return map;
    for (const p of room.participants) {
      if (map.has(p.userId)) continue;
      map.set(p.userId, OFFICE_ROOM_ROLE_LABELS[p.role === 'host' ? 'host' : 'participant']);
    }
    return map;
  }

  private async broadcastUpdate(msg: any, type: string): Promise<void> {
    const memberUserIds = await this.memberIds(msg.chatId);
    this.events.emit(
      type,
      { chatId: msg.chatId, message: this.toMessage(msg, '__broadcast__'), memberUserIds },
      'messenger',
    );
  }

  private async emitReceipt(
    chatId: string,
    userId: string,
    deliveredSeq: number,
    lastReadSeq: number,
  ): Promise<void> {
    const memberUserIds = await this.memberIds(chatId);
    this.events.emit(
      'messenger.receipt',
      { chatId, userId, deliveredSeq, lastReadSeq, memberUserIds },
      'messenger',
    );
  }

  private toMessage(
    r: any,
    viewerId: string,
    peerDeliveredSeq = 0,
    peerReadSeq = 0,
    labelMap?: Map<string, string | null>,
    showStatus = true,
  ): ChatMessage {
    const mine = r.authorId === viewerId;
    let status: MessageDeliveryStatus | undefined;
    if (mine && showStatus) {
      status = peerReadSeq >= r.seq ? 'read' : peerDeliveredSeq >= r.seq ? 'delivered' : 'sent';
    }
    const deleted = !!r.deletedAt;
    return {
      id: r.id,
      chatId: r.chatId,
      authorId: r.authorId ?? null,
      authorName: r.author ? fullName(r.author) : null,
      authorAvatar: r.author?.avatar ?? null,
      authorRoleTag: r.authorId ? labelMap?.get(r.authorId) ?? null : null,
      type: r.type,
      content: deleted ? null : r.content ?? null,
      payload: deleted ? null : ((r.payload as Record<string, unknown> | null) ?? null),
      seq: r.seq,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      mine,
      status,
      replyTo: r.replyTo ? this.toReplyPreview(r.replyTo) : null,
    };
  }

  /** Compact preview of a quoted message (Phase 7). Null text for a deleted quote. */
  private toReplyPreview(rt: any): MessageReplyPreview {
    const deleted = !!rt.deletedAt;
    let text: string | null;
    if (deleted) text = null;
    else if (rt.type === 'text') text = rt.content ?? '';
    else if (rt.type === 'attachment') text = rt.content || this.attachmentPreviewText(rt.payload);
    else if (rt.type === 'system') text = (rt.payload?.text as string) ?? 'Системное сообщение';
    else text = (rt.payload?.title as string) ?? 'Карточка';
    return {
      id: rt.id,
      authorName: rt.author ? fullName(rt.author) : null,
      text,
      deleted,
    };
  }

  /** Превью attachment-сообщения без подписи — формулировки в @superapp/shared (одна точка с веб-фолбэком) */
  private attachmentPreviewText(payload: unknown): string {
    return attachmentPreviewText((payload as { files?: Array<{ kind?: string; profile?: string }> } | null)?.files);
  }

  private toPreview(r: any): MessagePreview {
    const deleted = !!r.deletedAt;
    let text: string | null;
    if (deleted) text = 'Сообщение удалено';
    else if (r.type === 'text') text = r.content ?? '';
    else if (r.type === 'attachment') text = r.content || this.attachmentPreviewText(r.payload);
    else if (r.type === 'system') text = (r.payload?.text as string) ?? 'Системное сообщение';
    else text = (r.payload?.title as string) ?? 'Карточка';
    return {
      id: r.id,
      seq: r.seq,
      authorId: r.authorId ?? null,
      authorName: r.author ? fullName(r.author) : null,
      type: r.type,
      text,
      createdAt: r.createdAt.toISOString(),
      deleted,
    };
  }
}
