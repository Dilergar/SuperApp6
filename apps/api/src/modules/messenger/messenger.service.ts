import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SOURCE_LOCALE } from '@superapp/shared';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../../core/analytics/analytics.service';
import { fullName, fullNameOrNull } from '../../shared/utils/user-name';
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
import { DriveRoutingRegistry } from '../drive/drive-routing.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { NotificationsRenderer } from '../../core/notifications/notifications.render';
import { DELETED_USER_MARKER, renderChatter, resolveLabelKeys, type ChatterEntryLike } from '@superapp/i18n';
import {
  MESSENGER_LIMITS,
  OFFICE_ROOM_ROLE_LABEL_KEYS,
  attachmentPreviewKind,
  lifecyclePolicy,
  plaquePersonProblems,
  redactPlaquePersonRefs,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { deletableSql, holdFreeSql, lifecycleTableOf, lockHoldsShared } from '../../core/lifecycle/lifecycle.sql';
import type { LifecycleSubjectEraseContext } from '../../core/lifecycle/lifecycle.purge.registry';
import { LifecycleHoldsService } from '../../core/lifecycle/lifecycle.holds.service';
import { CHAT_TIMER_TYPES, MessengerRetentionService } from './messenger-retention.service';
import { utcTs } from '../../shared/database/sql-time';
import type {
  CallActiveDto,
  ChatCallStatePayload,
  ChatType,
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
  WsCallState,
  WsMessageNew,
  WsMessageUpdated,
  WsReceipt,
} from '@superapp/shared';

/** Снимок сообщения для hold store (оригинал до правки/удаления под заморозкой). */
function messageSnapshot(m: { id: string; chatId: string; authorId: string | null; type: string; content: string | null; payload: Prisma.JsonValue | null; seq: number; replyToId: string | null; editedAt: Date | null; deletedAt: Date | null; createdAt: Date }): Record<string, unknown> {
  return {
    id: m.id,
    chatId: m.chatId,
    authorId: m.authorId,
    type: m.type,
    content: m.content,
    payload: m.payload,
    seq: m.seq,
    replyToId: m.replyToId,
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    preservedAt: new Date().toISOString(),
  };
}

/** Сообщений за один UPDATE при стирании «всех моих сообщений» (томбстоун) */
const ERASE_MESSAGES_BATCH = 500;

/** Сообщений за один DELETE при окончательном удалении чата */
const PURGE_MESSAGES_BATCH = 5000;

type Principal = { type: string; id: string };

const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

// Message include with the quoted message (Phase 7 reply/quote) — used wherever a message
// is serialized for display (getMessages, send, edit) so the reply chip resolves with no N+1.
const MESSAGE_REPLY_INCLUDE = {
  author: { select: USER_LITE },
  replyTo: {
    select: {
      id: true,
      seq: true,
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
// Роль автора рядом с именем в контекстном чате: КЛЮЧ каталога, слово
// подставляется при чтении в языке зрителя.
const TASK_ROLE_LABEL_KEYS: Record<string, string> = {
  creator: 'tasks.role.creator',
  executor: 'tasks.role.executor',
  co_executor: 'tasks.role.co_executor',
  observer: 'tasks.role.observer',
};

// Order role → Russian label shown next to an author's name in an order (context) chat.
const ORDER_ROLE_LABEL_KEYS: Record<string, string> = {
  buyer: 'shop.role.buyer',
  seller: 'shop.role.seller',
  contributor: 'shop.role.contributor',
};

// Event role → Russian label shown next to an author's name in an event (context) chat.
const EVENT_ROLE_LABEL_KEYS: Record<string, string> = {
  organizer: 'calendar.role.organizer',
  attendee: 'calendar.role.attendee',
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
/**
 * Структура плашки, которую ставит СЕРВИС: ключ типа записи хроники
 * (`chatter.type.<typeKey>`) и значения ICU. Готового текста здесь нет намеренно —
 * он собирается при чтении в языке зрителя (правило render-at-read, docs/i18n.md).
 */
/** Плашек за пачку в шаге стирания (у активного человека их тысячи). */
const PLAQUE_REDACT_BATCH = 500;

export interface SystemPlaque {
  typeKey: string;
  /** Имена людей — парами `PERSON_NAME_REFS` (`targetName` ↔ `targetUserId`), иначе стирание их не найдёт */
  values?: Record<string, string | number>;
  /** Чьё имя в `values.actorName` — обязателен, когда имя есть */
  actorId?: string | null;
}

@Injectable()
export class MessengerService implements OnModuleInit {
  private readonly logger = new Logger(MessengerService.name);

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
    private driveRouting: DriveRoutingRegistry,
    private redis: RedisService,
    private i18n: I18nService,
    private notificationsRenderer: NotificationsRenderer,
    private analytics: AnalyticsService,
    private holds: LifecycleHoldsService,
    private retention: MessengerRetentionService,
  ) {}

  /** Снимок для БД — в языке ИСТОЧНИКА (зритель перерисует его при чтении). */
  private src(key: string, params?: Record<string, string>): string {
    return this.i18n.translateFor(SOURCE_LOCALE, key, params);
  }

  onModuleInit(): void {
    // Ф9 (вложения): доступ к файлу наследуется от сообщения → чата (модель
    // Salesforce ContentDocumentLink; перепроверка на каждый доступ, тюплов нет).
    this.filesRegistry.register('chat_message', {
      canView: async (viewerId, messageId) => {
        const m = await this.db.message.findUnique({
          where: { id: messageId },
          select: { chatId: true, deletedAt: true, seq: true, chat: { select: { id: true, type: true, workspaceId: true, messageTtlDays: true } } },
        });
        // Сообщение вне срока чата (таймер, срок организации) уже не показывается — и его файл тоже
        if (!m || m.deletedAt || (await this.retention.isExpired(m.chat, m))) return false;
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
      // Правка СОДЕРЖИМОГО (движок документов): общий .xlsx в чате правят ВСЕ участники,
      // а не только приславший — поэтому здесь, в отличие от canAttach, авторства
      // сообщения не требуется. Прикрепить новый файл к чужому сообщению по-прежнему
      // нельзя: это разные права, и именно ради этого предикат отдельный.
      canEditContent: async (uid, messageId) => {
        const m = await this.db.message.findUnique({
          where: { id: messageId },
          select: { chatId: true, deletedAt: true, seq: true, chat: { select: { id: true, type: true, workspaceId: true, messageTtlDays: true } } },
        });
        if (!m || m.deletedAt || (await this.retention.isExpired(m.chat, m))) return false;
        return this.access.can(this.user(uid), 'chat.post', m.chatId);
      },
      // 'drive_file' — чтобы работала кнопка «Прикрепить с Диска»: файл, загруженный
      // профилем Диска, обязан приниматься вложением, иначе привязка молча отвергается.
    }, { allowedProfiles: ['chat_attachment', 'voice_message', 'drive_file'] });

    // Свои загрузки из переписки складываются на Диск сами (модель Teams). Куда
    // именно — решает МЕССЕНДЖЕР, потому что только он знает природу чата:
    // ЛИЧНАЯ переписка двух коллег не должна всплывать на общем диске организации,
    // поэтому из DM файл всегда уходит на личный диск, даже в рабочем контексте.
    this.driveRouting.register('chat_message', {
      resolvePlacement: async (messageId, actorId) => {
        const m = await this.db.message.findUnique({
          where: { id: messageId },
          select: { chat: { select: { type: true, workspaceId: true } } },
        });
        if (!m?.chat) return null;
        if (m.chat.type === 'dm' || !m.chat.workspaceId) {
          return { ownerType: 'user', ownerId: actorId };
        }
        return { ownerType: 'workspace', ownerId: m.chat.workspaceId };
      },
    });

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
        // Не вечная запись: это СОСТОЯНИЕ звонка в сокете, оно живёт минуты и
        // собирается заново на каждом чтении — язык запроса здесь и есть язык зрителя.
        // eslint-disable-next-line i18n/no-viewer-text-in-payload
        chatTitle: chat.title ?? startedByName ?? this.i18n.translate('messenger.callFallback'),
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
    const wsPayload: WsCallState = { ...built.payload, memberUserIds: built.memberUserIds };
    this.events.emit('messenger.call.state', wsPayload, 'messenger');
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
    if (peerId === userId) throw badRequest('chat.selfDm');
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
          await this.analytics.track(tx, 'messenger.chat.created', { kind: 'dm' }, { userId });
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
    if (!chat) throw notFound('chat.notFound');
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
      'contacts.notInCircle',
      opts,
    );
  }

  // ============================================================
  // Access (engine is authoritative; ChatMember mirrors membership)
  // ============================================================
  private async assertAccess(userId: string, chatId: string): Promise<void> {
    const ok = await this.access.can(this.user(userId), 'chat.view', chatId);
    if (!ok) throw forbidden('chat.noAccess');
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
    if (!chat) throw notFound('chat.notFound');
    if (chat.type !== 'group') throw badRequest('chat.notGroup');

    const me = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { role: true, leftAt: true },
    });
    if (!me || me.leftAt) throw forbidden('chat.noAccess');
    const role = me.role as ChatMemberRole;
    if (opts?.ownerOnly) {
      if (role !== 'owner') throw forbidden('chat.ownerOnly');
    } else if (role !== 'owner' && role !== 'admin') {
      throw forbidden('chat.notEnoughRights');
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
    await this.analytics.track(null, 'messenger.chat.created', { kind: 'group' }, { userId });

    const creator = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postStructuredSystemMessage(
      chat.id,
      'group.created',
      {
        // Имени нет → пустая строка: рендер плашки подставит слово каталога в языке
        // ЧИТАТЕЛЯ. Записанное здесь, оно застыло бы английским навсегда.
        actorName: fullNameOrNull(creator) ?? '',
        name,
      },
      userId,
    );

    return this.getChatDetail(userId, chat.id);
  }

  async renameGroup(userId: string, chatId: string, title: string): Promise<ChatDetail> {
    await this.assertManage(userId, chatId);
    await this.db.chat.update({ where: { id: chatId }, data: { title } });

    const actor = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postStructuredSystemMessage(chatId, 'group.renamed', { actorName: fullNameOrNull(actor) ?? '', title }, userId);
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
        await this.postStructuredSystemMessage(chatId, 'group.member_added', this.targetValues(id, names));
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
    if (!target) throw notFound('chat.memberNotFound');
    if (target.role === 'owner') throw badRequest('chat.cannotRemoveOwner');

    await this.db.chatMember.delete({ where: { id: target.id } });
    // Instant Hard Revoke: drop the membership tuple.
    await this.access.revoke(this.memberTuple(chatId, targetId));

    const names = await this.namesOf([targetId]);
    await this.postStructuredSystemMessage(chatId, 'group.member_removed', this.targetValues(targetId, names));
    return this.getChatDetail(userId, chatId);
  }

  async leaveGroup(userId: string, chatId: string): Promise<void> {
    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { type: true },
    });
    if (!chat) throw notFound('chat.notFound');
    if (chat.type !== 'group') throw badRequest('chat.notGroup');

    const me = await this.db.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { id: true, role: true },
    });
    if (!me) throw forbidden('chat.notInGroup');
    if (me.role === 'owner') {
      throw badRequest('chat.transferOrDelete');
    }

    await this.db.chatMember.delete({ where: { id: me.id } });
    await this.access.revoke(this.memberTuple(chatId, userId));

    const actor = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
    await this.postStructuredSystemMessage(chatId, 'group.member_left', { actorName: fullNameOrNull(actor) ?? '' }, userId);
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
    if (!target) throw notFound('chat.memberNotFound');
    if (target.role === 'owner') throw badRequest('chat.ownerImmutable');

    await this.db.chatMember.update({
      where: { id: target.id },
      data: { role: makeAdmin ? 'admin' : 'member' },
    });

    if (makeAdmin) {
      const names = await this.namesOf([targetId]);
      await this.postStructuredSystemMessage(chatId, 'group.admin_granted', this.targetValues(targetId, names));
    }
    return this.getChatDetail(userId, chatId);
  }

  async deleteGroup(userId: string, chatId: string): Promise<void> {
    await this.assertManage(userId, chatId, { ownerOnly: true });
    // Группа под заморозкой (чат, организация, хранитель автора, запись сообщения) целиком не
    // удаляется — 409 с нейтральным текстом, ничего не тронуто
    if ((await this.purgeChat(chatId)) === 'held') throw conflict('lifecycle.held');
  }

  // ============================================================
  // Task (context) chats — replaces TaskComment
  // ============================================================

  /**
   * Find or create the chat for a task. NOTE: in practice the chat is created
   * EAGERLY — the first chat-posted chronicle entry (e.g. task.assigned) is drained
   * by the ChatterChatSink which calls postTaskSystemMessage → here — so by the time
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
      where: { id: taskId, deletedAt: null },
      select: {
        title: true,
        creatorId: true,
        workspaceId: true,
        participants: { select: { userId: true, role: true } },
      },
    });
    if (!task) throw notFound('task.notFound');

    // Engine: usersets bind chat membership to the task's roles (creator always + each
    // distinct participant role present). Materialized ChatMember rows mirror the same set.
    const roles = new Set<string>(['creator']);
    for (const p of task.participants) roles.add(p.role);
    const memberUserIds = new Set<string>([task.creatorId]);
    for (const p of task.participants) memberUserIds.add(p.userId);

    // ATOMIC creation: commit the chat row AND its access-membership tuples in ONE
    // transaction. Previously the row was committed first and the tuples granted in a
    // separate step; a concurrent reader (the eager chatter chat-sink racing the user's
    // own open — the window widens at cold start when queries are slow) could find the row
    // in that gap and see a chat with NO members → chat.view computed false → transient
    // false 403. Committing them together makes a findable chat ALWAYS grant its members.
    // The chat id is brand-new, so no cached check can reference it yet → no epoch bump
    // needed to invalidate anything (the old grantMany's chat-epoch bump is dropped).
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          // Организация чата = организация задачи: вложения уходят на её Диск, звонки — её,
          // каскад её удаления находит чат (docs/lifecycle_engine.md)
          data: { type: 'context', parentType: 'task', parentId: taskId, title: task.title, workspaceId: task.workspaceId ?? null },
          select: sel,
        });
        await this.analytics.track(tx, 'messenger.chat.created', { kind: 'context' });
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
    if (!canView) throw forbidden('chat.taskNoAccess');
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
        where: { id: taskId, deletedAt: null },
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

  /**
   * «Стереть все мои сообщения» (мастер удаления аккаунта, шаг `messenger.subject`): томбстоун —
   * content и payload NULL, момент удаления; вложения отвязываются (осиротевший файл уйдёт шагом
   * файлов), проекции поиска удаляются. Сообщения под заморозкой остаются (`held`) — в самом
   * операторе, под общим замком заморозок. Пачками, идемпотентно (томбстоун повторно не
   * выбирается); `deadline` прошёл — `done: false`, продолжит следующий заход.
   */
  async eraseAuthoredMessages(userId: string, deadline: number | null, held: (rows: number) => void): Promise<{ rows: number; done: boolean }> {
    const policy = lifecyclePolicy('Message')!;
    const t = lifecycleTableOf(policy)!;
    let rows = 0;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows, done: false };
      const touched = await this.db.$transaction(async (tx) => {
        await lockHoldsShared(tx);
        return tx.$queryRaw<Array<{ id: string; type: string }>>`
          WITH d AS (
            SELECT t.id FROM "messages" t
             WHERE t.author_id = ${userId}::uuid AND (t.content IS NOT NULL OR t.payload IS NOT NULL OR t.deleted_at IS NULL)
               AND ${holdFreeSql(policy, t)}
             LIMIT ${ERASE_MESSAGES_BATCH}
             FOR UPDATE OF t SKIP LOCKED)
          UPDATE "messages" m SET content = NULL, payload = NULL, deleted_at = COALESCE(m.deleted_at, ${utcTs(new Date())})
            FROM d WHERE m.id = d.id
          RETURNING m.id::text AS id, m.type`;
      });
      for (const m of touched) {
        if (m.type === 'attachment') await this.files.unlinkAllForRef('chat_message', m.id).catch(() => undefined);
        await this.searchIndex.removeMessage(m.id).catch(() => undefined);
      }
      rows += touched.length;
      if (touched.length < ERASE_MESSAGES_BATCH) break;
    }
    // SKIP LOCKED пропускает строки, занятые чужой транзакцией (ответ со ссылкой на сообщение,
    // реакция): неполная пачка — ещё не «всё». Осталось свободное от заморозок — шаг не закончен,
    // следующий заход оркестратора доберёт (иначе текст пережил бы выбор «стереть все мои»)
    const [left] = await this.db.$queryRaw<Array<{ left: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "messages" t
         WHERE t.author_id = ${userId}::uuid AND (t.content IS NOT NULL OR t.payload IS NOT NULL OR t.deleted_at IS NULL)
           AND ${holdFreeSql(policy, t)}) AS left`;
    if (left?.left) return { rows, done: false };
    const [h] = await this.db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "messages" t
       WHERE t.author_id = ${userId}::uuid AND (t.content IS NOT NULL OR t.payload IS NOT NULL) AND NOT (${holdFreeSql(policy, t)})`;
    const heldRows = Number(h?.n ?? 0);
    if (heldRows) held(heldRows);
    return { rows, done: true };
  }

  /**
   * Стирание человека (шаг `messenger.subject`): по выбору — все его сообщения томбстоуном;
   * затем членства. Личный чат остаётся собеседнику, строка участника — ссылка на томбстоун
   * («Удалённый аккаунт», как у Telegram), личное состояние (закреп, звук, архив) обнуляется.
   * Группа — выход; владение — старейшему админу, иначе старейшему участнику; пустая группа
   * удаляется. Контекстный чат (задача, заказ, встреча) — выход без плашки. Членство под
   * заморозкой (чат, организация чата, хранитель) остаётся — улика состава.
   */
  async eraseMember(userId: string, ctx: LifecycleSubjectEraseContext): Promise<{ rows: number; done: boolean }> {
    let rows = 0;
    // Имена человека в системных плашках чатов — метка томбстоуна. Хранитель заморозки — улика:
    // имена остаются до снятия, шаг досчитает следующим заходом
    if (ctx.subjectHeld) ctx.held(1);
    else {
      const r = await this.redactPlaques(userId, ctx.deadline);
      rows += r.rows;
      if (!r.done) return { rows, done: false };
    }
    if (ctx.options.eraseMessages) {
      const r = await this.eraseAuthoredMessages(userId, ctx.deadline, (n) => ctx.held(n));
      rows += r.rows;
      if (!r.done) return { rows, done: false };
    }
    const memberships = await this.db.chatMember.findMany({
      where: { userId },
      select: { id: true, chatId: true, role: true, chat: { select: { type: true } } },
      orderBy: { id: 'asc' },
    });
    for (const m of memberships) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows, done: false };
      const free = await this.db.$transaction((tx) => ctx.releasable(tx, 'ChatMember', [m.id]));
      if (!free.length) {
        ctx.held(1);
        continue;
      }
      if (m.chat.type === 'dm') {
        await this.db.chatMember.update({ where: { id: m.id }, data: { pinned: false, archived: false, mutedUntil: null } });
        // Личный чат, где стёрты все собеседники (или «Избранное» с самим собой), не видит больше
        // никто — удаляется целиком (DELF refcount: беседа умирает с последним живым участником)
        const alive = await this.db.chatMember.count({ where: { chatId: m.chatId, userId: { not: userId }, user: { deletedAt: null } } });
        if (!alive) {
          const r = await this.purgeChat(m.chatId, ctx.deadline);
          if (r === false) return { rows, done: false };
          if (r === 'held') ctx.held(1);
          else rows++;
        }
        continue;
      }
      if (m.chat.type === 'group' && m.role === 'owner') {
        const others = { chatId: m.chatId, userId: { not: userId }, leftAt: null };
        const heir =
          (await this.db.chatMember.findFirst({ where: { ...others, role: 'admin' }, orderBy: { joinedAt: 'asc' }, select: { id: true } })) ??
          (await this.db.chatMember.findFirst({ where: { ...others, role: 'member' }, orderBy: { joinedAt: 'asc' }, select: { id: true } }));
        if (!heir) {
          const r = await this.purgeChat(m.chatId, ctx.deadline);
          if (r === false) return { rows, done: false };
          if (r === 'held') ctx.held(1);
          else rows++;
          continue;
        }
        await this.db.chatMember.update({ where: { id: heir.id }, data: { role: 'owner' } });
      }
      await this.db.chatMember.deleteMany({ where: { id: m.id } });
      await this.access.revoke(this.memberTuple(m.chatId, userId));
      if (m.chat.type === 'group') await this.postStructuredSystemMessage(m.chatId, 'group.member_left', { actorName: ctx.deletedLabel });
      rows++;
    }
    return { rows, done: true };
  }

  /**
   * Имена стираемого человека в системных плашках (реестр: `Message.personIds`): актор записи,
   * цель, «было → стало», событие уведомления — метка томбстоуна вместо имени и пересобранный
   * снимок текста в языке источника. Плашки находит частичный GIN-индекс `message_person_ids`
   * (без скана переписки); id остаётся — зритель рисует «удалённого пользователя» на своём
   * языке. Оригинал плашки под заморозкой уходит в hold store той же транзакцией. Идемпотентно:
   * переписанная плашка при повторе не меняется.
   */
  private async redactPlaques(userId: string, deadline: number | null): Promise<{ rows: number; done: boolean }> {
    const label = DELETED_USER_MARKER;
    let rows = 0;
    let after: string | null = null;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows, done: false };
      const batch: Array<{ id: string; chatId: string; authorId: string | null; type: string; content: string | null; payload: Prisma.JsonValue | null; seq: number; replyToId: string | null; editedAt: Date | null; deletedAt: Date | null; createdAt: Date }> =
        await this.db.$queryRaw`
          SELECT id::text AS id, chat_id::text AS "chatId", author_id::text AS "authorId", type, content, payload, seq,
                 reply_to_id::text AS "replyToId", edited_at AS "editedAt", deleted_at AS "deletedAt", created_at AS "createdAt"
            FROM "messages"
           WHERE type = 'system' AND message_person_ids(payload) <> '{}'::text[]
             AND message_person_ids(payload) @> ARRAY[${userId}]::text[]
             ${after ? Prisma.sql`AND id > ${after}::uuid` : Prisma.empty}
           ORDER BY id LIMIT ${PLAQUE_REDACT_BATCH}`;
      if (!batch.length) return { rows, done: true };
      for (const m of batch) {
        const next = redactPlaquePersonRefs(m.payload, userId, label);
        if (!next.changed) continue;
        const payload = { ...(next.payload as Record<string, unknown>) };
        const text = this.plaqueSnapshot(payload);
        // Снимок не пересобрать (тип ушёл из каталога) — старый с именем не остаётся
        if (text === null) delete payload.text;
        else payload.text = text;
        await this.db.$transaction(async (tx) => {
          await this.holds.preserve(tx, 'Message', m.id, messageSnapshot(m));
          await tx.message.update({ where: { id: m.id }, data: { payload: payload as Prisma.InputJsonValue } });
        });
        rows++;
      }
      after = batch[batch.length - 1]!.id;
      if (batch.length < PLAQUE_REDACT_BATCH) return { rows, done: true };
    }
  }

  /** Снимок плашки в языке источника — после правки её структуры. `null` — не пересобрать. */
  private plaqueSnapshot(p: Record<string, unknown>): string | null {
    const typeKey = typeof p.eventType === 'string' ? p.eventType : null;
    if (typeKey === 'notification') {
      const n = p.notification as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (!n?.type) return null;
      const r = this.notificationsRenderer.render(SOURCE_LOCALE, n.type, n.payload ?? {});
      return r.body ? `${r.title}\n${r.body}` : r.title;
    }
    const source = p.chatter as ChatterEntryLike | undefined;
    const key = typeof p.chatterTypeKey === 'string' ? p.chatterTypeKey : typeKey;
    if (!key || !source) return null;
    const rendered = renderChatter(this.i18n.forLocale(SOURCE_LOCALE), key, source, this.i18n.format(SOURCE_LOCALE));
    return rendered === key ? null : rendered;
  }

  /**
   * Окончательно удалить чат — ЕДИНСТВЕННАЯ дверь (группа, контекстные чаты задачи, заказа,
   * события и встречи, каскад организации, стирание человека). Под заморозкой (сам чат, его
   * организация, хранитель автора, запись или класс сообщений) чат не трогается вовсе —
   * `'held'` (переписка вокруг удерживаемого — тоже улика). Иначе сообщения уходят пачками под
   * общим замком заморозок (крупный чат одним DELETE держал бы замки минутами и раздувал WAL) с
   * привязками своих вложений; строка чата (участники и отложенные — каскадом FK) — последней,
   * в транзакции с повторной проверкой: заморозка, поставленная посреди, оставит чат с
   * удержанным. Права и индекс поиска снимаются после строки (висячий кортеж безвреден, его
   * добирает loose FK; чат без кортежей был бы невидим участникам). Идемпотентно; `deadline`
   * прошёл — `false` (следующий заход продолжит).
   */
  async purgeChat(chatId: string, deadline: number | null = null): Promise<boolean | 'held'> {
    if (!(await this.db.$transaction((tx) => this.holds.allReleasable(tx, 'Chat', [chatId])))) return 'held';
    const policy = lifecyclePolicy('Message')!;
    const t = lifecycleTableOf(policy)!;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return false;
      const gone = await this.db.$transaction(async (tx) => {
        await lockHoldsShared(tx);
        return tx.$queryRaw<Array<{ id: string; type: string }>>`
          DELETE FROM "messages" m
           USING (SELECT t.ctid FROM "messages" t WHERE t.chat_id = ${chatId}::uuid AND ${deletableSql(policy, t)} ORDER BY t.seq DESC LIMIT ${PURGE_MESSAGES_BATCH}) d
           WHERE m.ctid = d.ctid
          RETURNING m.id::text AS id, m.type`;
      });
      // Вложения удалённых сообщений: привязка снимается сразу (сбой здесь доберёт loose FK Message → FileLink)
      const attachments = gone.filter((m) => m.type === 'attachment').map((m) => m.id);
      if (attachments.length) await this.files.unlinkAllForRefs('chat_message', attachments).catch(() => undefined);
      if (gone.length < PURGE_MESSAGES_BATCH) break;
    }
    const deleted = await this.db.$transaction(async (tx) => {
      if (!(await this.holds.allReleasable(tx, 'Chat', [chatId]))) return false;
      await tx.chat.deleteMany({ where: { id: chatId } });
      return true;
    });
    if (!deleted) return 'held';
    await this.access.revokeResource('chat', chatId);
    await this.searchIndex.removeChat(chatId).catch(() => undefined);
    return true;
  }

  /** Контекстный чат сущности, которой больше нет (задача, заказ, событие, встреча) — через единую дверь. */
  private async purgeContextChat(parentType: 'task' | 'order' | 'event' | 'office_room', parentId: string): Promise<void> {
    try {
      const chat = await this.db.chat.findFirst({ where: { parentType, parentId }, select: { id: true } });
      // Под заморозкой чат остаётся (улика); после снятия его добирает loose FK родителя
      if (chat) await this.purgeChat(chat.id);
    } catch (err) {
      this.logger.warn(`context chat of ${parentType} ${parentId} was not purged: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Каскад удаления организации (шаг `messenger.workspace-chats`): все чаты организации
   * (задач, заказов её магазина, встреч офиса) уходят окончательно; удерживаемые заморозкой —
   * остаются (строка организации тогда не удалится — каскад остановит заморозка).
   */
  async purgeWorkspaceChats(
    workspaceId: string,
    ctx: {
      deadline: number | null;
      checkpoint: () => Promise<void>;
      releasable: (tx: Prisma.TransactionClient, ids: readonly string[]) => Promise<string[]>;
    },
  ): Promise<{ rows: number; done: boolean }> {
    let rows = 0;
    let after: string | undefined;
    for (;;) {
      if (ctx.deadline !== null && Date.now() > ctx.deadline) return { rows, done: false };
      await ctx.checkpoint();
      const chats = await this.db.chat.findMany({
        where: { workspaceId, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 50,
      });
      if (!chats.length) return { rows, done: true };
      const ok = await this.db.$transaction((tx) => ctx.releasable(tx, chats.map((c) => c.id)));
      for (const id of ok) {
        const r = await this.purgeChat(id, ctx.deadline);
        if (r === false) return { rows, done: false };
        // Удержанный посреди прогона чат остаётся — строку организации тогда удержит её проверка
        if (r === true) rows++;
      }
      after = chats[chats.length - 1]!.id;
    }
  }

  /** Best-effort: delete the task's chat when the task is deleted. */
  async deleteTaskChat(taskId: string): Promise<void> {
    await this.purgeContextChat('task', taskId);
  }

  /**
   * Public: post a system message to a task's chat, ensuring the chat exists.
   * Плашки задач производит движок хроники (core/chatter → ChatterChatSink):
   * eventType = typeKey записи, extra несёт chatterEntryId (идемпотентность —
   * на claim'е движка).
   */
  async postTaskSystemMessage(
    taskId: string,
    eventType: SystemMessageEvent | string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const chat = await this.getOrCreateTaskChat(taskId);
    await this.postSystemMessage(chat.id, eventType, text, extra);
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
        listing: { select: { showcase: { select: { shop: { select: { ownerType: true, ownerId: true } } } } } },
      },
    });
    if (!order) throw notFound('chat.orderNotFound');
    const orderShop = order.listing?.showcase.shop;
    const orderWorkspaceId = orderShop?.ownerType === 'workspace' ? orderShop.ownerId : null;

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
          data: { type: 'context', parentType: 'order', parentId: orderId, title: order.titleSnapshot, workspaceId: orderWorkspaceId },
          select: sel,
        });
        await this.analytics.track(tx, 'messenger.chat.created', { kind: 'context' });
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
    if (!canView) throw forbidden('chat.orderNoAccess');
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
    await this.purgeContextChat('order', orderId);
  }

  /**
   * Public: плашка в чат заказа (чат создаётся при необходимости). Структурная: текст
   * собирается при чтении в языке зрителя, в БД — снимок языка источника.
   */
  async postOrderSystemMessage(
    orderId: string,
    eventType: SystemMessageEvent | string,
    plaque: SystemPlaque,
  ): Promise<void> {
    const chat = await this.getOrCreateOrderChat(orderId);
    await this.postPlaque(chat.id, eventType, plaque);
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
      where: { id: eventId, deletedAt: null },
      select: { title: true, userId: true, participants: { select: { userId: true } } },
    });
    if (!event) throw notFound('calendar.eventNotFound');

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
        await this.analytics.track(tx, 'messenger.chat.created', { kind: 'context' });
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
    if (!canView) throw forbidden('chat.eventNoAccess');
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
        where: { id: eventId, deletedAt: null },
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
    await this.purgeContextChat('event', eventId);
  }

  /**
   * Public: плашка в чат события календаря (чат создаётся при необходимости). Структурная,
   * имена людей — парами с id (стирание их находит).
   */
  async postEventSystemMessage(
    eventId: string,
    eventType: SystemMessageEvent | string,
    plaque: SystemPlaque,
  ): Promise<void> {
    const chat = await this.getOrCreateEventChat(eventId);
    await this.postPlaque(chat.id, eventType, plaque);
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
      select: { name: true, workspaceId: true, participants: { select: { userId: true } } },
    });
    if (!room) throw notFound('chat.roomNotFound');

    const memberUserIds = new Set<string>(room.participants.map((p) => p.userId));

    // ATOMIC creation (see getOrCreateTaskChat): chat row + membership tuples + materialized
    // members in ONE transaction, so a concurrent reader never observes a member-less chat.
    try {
      return await this.db.$transaction(async (tx) => {
        const chat = await tx.chat.create({
          data: { type: 'context', parentType: 'office_room', parentId: roomId, title: room.name, workspaceId: room.workspaceId },
          select: sel,
        });
        await this.analytics.track(tx, 'messenger.chat.created', { kind: 'context' });
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
    if (!canView) throw forbidden('chat.roomNoAccess');
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
    await this.purgeContextChat('office_room', roomId);
  }

  /** Public: post a system plaque to a meeting's chat, ensuring the chat exists. */
  async postOfficeRoomSystemMessage(
    roomId: string,
    eventType: SystemMessageEvent | string,
    plaque: SystemPlaque,
  ): Promise<void> {
    const chat = await this.getOrCreateOfficeRoomChat(roomId);
    await this.postPlaque(chat.id, eventType, plaque);
  }

  /** Public: плашка прямо в чат по id (итоги звонков — ChatCallsListener). */
  async postChatSystemMessage(
    chatId: string,
    eventType: SystemMessageEvent | string,
    plaque: SystemPlaque,
  ): Promise<void> {
    await this.postPlaque(chatId, eventType, plaque);
  }

  /**
   * Плашка, которую ставит СЕРВИС (офис, звонки, офисный документ), а не движок
   * хроники. Продюсер называет ТИП и значения — текст собирается при чтении в
   * языке зрителя (`systemText`), а в БД ложится снимок языка источника.
   *
   * Ключ типа едет отдельным полем: имя СОБЫТИЯ шины (`office.room.created`) не
   * совпадает с ключом записи хроники (`office.room_created`), а `eventType` в
   * payload читают клиенты — менять его нельзя.
   */
  private async postPlaque(
    chatId: string,
    eventType: SystemMessageEvent | string,
    plaque: SystemPlaque,
  ): Promise<void> {
    const values = plaque.values ?? {};
    const actorName =
      typeof values.actorName === 'string' && values.actorName.trim() ? values.actorName : null;
    const src = this.i18n.forLocale(SOURCE_LOCALE);
    const snapshotValues = actorName
      ? values
      : { ...values, actorName: src('common.labels.someone') };
    const snapshot = src(
      `chatter.type.${plaque.typeKey}`,
      resolveLabelKeys(src, snapshotValues),
    );
    await this.postSystemMessage(chatId, eventType, snapshot, {
      chatterTypeKey: plaque.typeKey,
      chatter: { refType: 'chat', actorName, ...(actorName && plaque.actorId ? { actorId: plaque.actorId } : {}), payload: values },
    });
  }

  /**
   * Канал `chat` движка уведомлений: системное сообщение с событием уведомления в
   * payload (перерисовывается в языке читателя, см. systemText). Идемпотентно по
   * eventId — ретрай канального джоба не дублит плашку.
   */
  async postNotificationMessage(
    chatId: string,
    input: { type: string; text: string; payload: Record<string, unknown>; href: string | null; ref: { type: string; id: string } | null; eventId: string },
  ): Promise<string | null> {
    const dup = await this.db.message.findFirst({
      where: { chatId, type: 'system', payload: { path: ['notificationEventId'], equals: input.eventId } },
      select: { id: true },
    });
    if (dup) return dup.id;
    await this.postSystemMessage(chatId, 'notification', input.text, {
      notificationEventId: input.eventId,
      notification: { type: input.type, payload: input.payload, href: input.href, ref: input.ref },
    });
    const created = await this.db.message.findFirst({
      where: { chatId, type: 'system', payload: { path: ['notificationEventId'], equals: input.eventId } },
      select: { id: true },
    });
    return created?.id ?? null;
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
    // Тип на ЛИТЕРАЛЕ, а не на приёме: gateway ретранслирует payload как есть, и
    // единственная точка, где компилятор способен поймать дрейф формы, — здесь.
    const wsPayload: WsMessageNew = {
      chatId,
      message: this.toMessage(msg, '__broadcast__'),
      memberUserIds,
      recipientIds,
      authorName: fullNameOrNull(msg.author) ?? '',
      // chat.type в БД — колонка String; перечисление живёт в коде (CHAT_TYPES).
      chatType: chatType as ChatType,
      preview: this.toPreview(msg).text,
    };
    this.events.emit('messenger.message.created', wsPayload, 'messenger');

    return this.toMessage(msg, authorId, 0, 0, undefined, chatType === 'dm');
  }

  // ============================================================
  // System messages
  // ============================================================
  /**
   * Системная плашка группы. Текст собирается ПРИ ЧТЕНИИ в языке зрителя
   * (`systemText` → `renderChatter` по ключу `chatter.type.<eventType>`), а
   * `text` остаётся СНИМКОМ в языке источника — фолбэком для типа, которого
   * однажды не станет в каталоге. Готовая русская строка в БД означала бы, что
   * казахоязычный участник навсегда читает плашку по-русски.
   */
  private async postStructuredSystemMessage(
    chatId: string,
    eventType: SystemMessageEvent,
    payload: Record<string, string>,
    /** Чьё имя в `payload.actorName` (стирание находит плашку по id) */
    actorId: string | null = null,
  ): Promise<void> {
    const src = this.i18n.forLocale(SOURCE_LOCALE);
    const snapshot = src(`chatter.type.${eventType}`, resolveLabelKeys(src, payload));
    await this.postSystemMessage(chatId, eventType, snapshot, {
      chatter: { refType: 'chat', actorName: payload.actorName ?? null, ...(actorId && payload.actorName ? { actorId } : {}), payload },
    });
  }

  /**
   * Цель плашки участника группы: имя парой с id (`PERSON_NAME_REFS`); нет имени — ключ слова
   * «участник», его подберёт язык читателя.
   */
  private targetValues(userId: string, names: ReadonlyMap<string, string>): Record<string, string> {
    const name = names.get(userId);
    return name ? { targetName: name, targetUserId: userId } : { targetNameKey: 'messenger.participantFallback', targetUserId: userId };
  }

  private async postSystemMessage(
    chatId: string,
    eventType: SystemMessageEvent | string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    // Идемпотентность плашки хроники: движок мог переклеймить запись после краха
    // между постом и отметкой успеха — если сообщение для этой записи уже есть,
    // выходим без дубля (chatterEntryId кладёт ChatterChatSink).
    // Имя человека в плашке — только парой с его id: иначе стирание его не найдёт и имя
    // переживёт аккаунт. В деве и сьютах — ошибка (ловится сразу), в проде — журнал. Проекция
    // записи хроники (`chatterEntryId`) проверена движком хроники при записи (актор без id
    // там законен: система, гость)
    const problems = extra.chatterEntryId ? [] : plaquePersonProblems(extra.chatter as Parameters<typeof plaquePersonProblems>[0], DELETED_USER_MARKER);
    if (problems.length) {
      const msg = `messenger plaque ${eventType}: person names without ids — ${problems.join('; ')}`;
      if (isDevEnv()) throw new Error(msg);
      this.logger.error(msg);
    }
    const chatterEntryId =
      typeof extra.chatterEntryId === 'string' ? extra.chatterEntryId : null;
    if (chatterEntryId) {
      const dup = await this.db.message.findFirst({
        where: {
          chatId,
          type: 'system',
          payload: { path: ['chatterEntryId'], equals: chatterEntryId },
        },
        select: { id: true },
      });
      if (dup) return;
    }

    // memberIds — ДО транзакции: после коммита сообщения не должно остаться
    // throwable-шага (иначе ошибка после durable-вставки → un-claim в движке →
    // дубль при редрайве). emit синхронный и не бросает.
    const memberUserIds = await this.memberIds(chatId);
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

    const wsPayload: WsMessageNew = {
      chatId,
      message: this.toMessage(msg, '__system__'),
      memberUserIds,
      // No recipientIds / notification fan-out: system plaques are silent.
      isSystem: true,
    };
    this.events.emit('messenger.message.created', wsPayload, 'messenger');
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

    // Срок чата (таймер, срок организации): превью и непрочитанные — только в нём
    const cutoffs = new Map<string, Date>();
    for (const m of visible) {
      const cutoff = await this.retention.cutoffOf(m.chat);
      if (cutoff) cutoffs.set(m.chatId, cutoff);
    }

    // Unread per chat in ONE indexed range query (seq > cursor) — NOT a scan of the
    // full history (the old groupBy counted every message of every chat ever).
    const unreadByChat = await this.computeUnread(userId, visible.map((m) => m.chatId), cutoffs);

    // Живые созвоны батчем (баннер «Идёт звонок» в инбоксе) — движок читает свои таблицы сам
    const activeCalls = await this.calls.getActiveForRefs('chat', visible.map((m) => m.chatId));

    const summaries: ChatSummary[] = visible.map((m) => {
      const chat = m.chat;
      const newest = chat.messages[0] ?? null;
      const cutoff = cutoffs.get(chat.id);
      const last = newest && (!cutoff || newest.createdAt >= cutoff) ? newest : null;
      const peerMember = chat.type === 'dm' ? chat.members[0] : null;
      const peer = peerMember?.user ?? null;

      return {
        id: chat.id,
        type: chat.type as ChatSummary['type'],
        title: peer ? fullName(peer) : chat.title ?? this.i18n.translate('messenger.chatFallback'),
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
  private async computeUnread(userId: string, chatIds: string[], cutoffs: ReadonlyMap<string, Date> = new Map()): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!chatIds.length) return result;
    // Сообщения вне срока чата не «непрочитанные»: граница — момент (колонка без пояса, UTC)
    const cutIds = [...cutoffs.keys()];
    const cutAt = cutIds.map((id) => cutoffs.get(id)!.toISOString());

    const rows = await this.db.$queryRaw<Array<{ chatId: string; unread: number }>>(Prisma.sql`
      SELECT m.chat_id AS "chatId", COUNT(*)::int AS unread
      FROM messages m
      JOIN chat_members cm
        ON cm.chat_id = m.chat_id AND cm.user_id = ${userId}::uuid AND cm.left_at IS NULL
      LEFT JOIN unnest(${cutIds}::uuid[], ${cutAt}::timestamptz[]) AS rc(chat_id, cutoff) ON rc.chat_id = m.chat_id
      WHERE m.chat_id = ANY(${chatIds}::uuid[])
        AND (rc.cutoff IS NULL OR m.created_at >= (rc.cutoff AT TIME ZONE 'UTC'))
        AND m.deleted_at IS NULL
        AND m.type <> 'system'
        AND m.author_id <> ${userId}::uuid
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
    if (!chat) throw notFound('chat.notFound');

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
      title: peer ? fullName(peer) : chat.title ?? this.i18n.translate('messenger.chatFallback'),
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
      // Таймер меняет любой участник личного чата, в группе — владелец и админ
      retention: await this.retention.describe(chat, chat.type === 'dm' || me?.role === 'owner' || me?.role === 'admin'),
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

    const chat = await this.db.chat.findUnique({
      where: { id: chatId },
      select: { id: true, type: true, parentType: true, parentId: true, workspaceId: true, messageTtlDays: true },
    });
    // Срок чата (таймер, срок организации) действует на чтении сразу: старше пола — не показывается
    const floor = chat ? await this.retention.floorOf(chat) : 0;

    const rows = await this.db.message.findMany({
      where: {
        chatId,
        seq: { gt: Math.max(visibleFrom, floor - 1), ...(beforeSeq ? { lt: beforeSeq } : {}) },
      },
      orderBy: { seq: 'desc' },
      take,
      include: MESSAGE_REPLY_INCLUDE,
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
      .map((r) => this.toMessage(r, userId, minDelivered, minRead, labelMap, showStatus, floor));
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
      select: { chatId: true, seq: true },
    });
    if (!parent || parent.chatId !== chatId) {
      throw badRequest('chat.quoteSameChat');
    }
    if (await this.expiredMessage(parent)) throw notFound('chat.messageNotFound');
  }

  /** Сообщение вне срока своего чата (таймер, срок организации) — чтение его уже не показывает. */
  private async expiredMessage(msg: { chatId: string; seq: number }): Promise<boolean> {
    const floor = await this.chatFloor(msg.chatId);
    return floor > 0 && msg.seq < floor;
  }

  /** Пол ленты чата (срок: таймер, срок организации); 0 — пола нет. Цитата старше — как удалённая. */
  private async chatFloor(chatId: string): Promise<number> {
    const chat = await this.db.chat.findUnique({ where: { id: chatId }, select: { id: true, type: true, workspaceId: true, messageTtlDays: true } });
    return chat ? this.retention.floorOf(chat) : 0;
  }

  /**
   * Можно ли процитировать сообщение в чате СЕЙЧАС: из этого чата и в его сроке. Отложенное
   * сообщение отправляется позже, чем составлено, — цитата, истёкшая к отправке, отбрасывается
   * (отправка без цитаты), а не хоронит само сообщение.
   */
  async isQuotable(chatId: string, messageId: string): Promise<boolean> {
    const parent = await this.db.message.findUnique({ where: { id: messageId }, select: { chatId: true, seq: true } });
    if (!parent || parent.chatId !== chatId) return false;
    return !(await this.expiredMessage(parent));
  }

  /** Текст сообщения для снимка уведомления — или пусто, если сообщение истечёт раньше уведомления. */
  async notificationSnippet(chatId: string, text: string): Promise<string> {
    const chat = await this.db.chat.findUnique({ where: { id: chatId }, select: { id: true, type: true, workspaceId: true, messageTtlDays: true } });
    return chat && !(await this.retention.snippetAllowed(chat)) ? '' : text;
  }

  // ============================================================
  // Таймер автоудаления сообщений (core/lifecycle Э5)
  // ============================================================

  /**
   * Включить, сменить или выключить таймер: личный чат — любой участник, группа — владелец и
   * админ; контекстный чат живёт жизнью предмета — таймера нет. В чате организации таймер не
   * длиннее её срока сообщений («выкл» = действует срок организации). Смена — системная
   * плашка всем (по ней клиенты перечитывают чат), факт аналитики; пол ленты этого процесса — сразу.
   */
  async setTimer(userId: string, chatId: string, days: number | null): Promise<ChatDetail> {
    await this.assertAccess(userId, chatId);
    const chat = await this.db.chat.findUnique({ where: { id: chatId }, select: { id: true, type: true, workspaceId: true, messageTtlDays: true } });
    if (!chat) throw notFound('chat.notFound');
    if (!CHAT_TIMER_TYPES.includes(chat.type)) throw badRequest('lifecycle.timerNotSupported');
    if (chat.type === 'group') {
      const me = await this.db.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } }, select: { role: true, leftAt: true } });
      if (!me || me.leftAt || (me.role !== 'owner' && me.role !== 'admin')) throw forbidden('chat.notEnoughRights');
    }
    const workspaceDays = await this.retention.workspaceDays(chat.workspaceId);
    if (days !== null && workspaceDays !== null && days > workspaceDays) throw badRequest('lifecycle.timerAboveWorkspace', { days: workspaceDays });
    if (chat.messageTtlDays === days) return this.getChatDetail(userId, chatId);

    const changed = await this.db.$transaction(async (tx) => {
      // Переход status-guarded: двойной клик не даёт двух плашек и двух фактов
      const { count } = await tx.chat.updateMany({
        where: { id: chatId, messageTtlDays: chat.messageTtlDays },
        data: { messageTtlDays: days, messageTtlSetById: userId, messageTtlSetAt: new Date() },
      });
      if (!count) return false;
      await this.analytics.track(tx, 'lifecycle.timer.set', { days: days ?? 0, chatType: chat.type, workspace: !!chat.workspaceId }, { userId, workspaceId: chat.workspaceId });
      return true;
    });
    this.retention.invalidate(chatId);
    if (changed) {
      const actor = await this.db.user.findUnique({ where: { id: userId }, select: USER_LITE });
      await this.postStructuredSystemMessage(
        chatId,
        days === null ? 'chat.timer_off' : 'chat.timer_set',
        { actorName: fullNameOrNull(actor) ?? '', ...(days !== null ? { days: String(days) } : {}) },
        userId,
      );
    }
    return this.getChatDetail(userId, chatId);
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
    // memberIds — ДО транзакции (то же правило, что в postSystemMessage): после коммита
    // сообщения не должно остаться ни одного throwable-шага. Иначе блип БД здесь →
    // отправитель-джоб (messenger.scheduled.fire) вернёт свою строку в pending и отдаст
    // ошибку движку → ретрай создаст ВТОРОЕ сообщение, и так до 8 копий в чате.
    const memberUserIds = await this.memberIds(chatId);
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

    const recipientIds = memberUserIds.filter((id) => id !== userId);

    const wsPayload: WsMessageNew = {
      chatId,
      message: this.toMessage(msg, '__broadcast__'),
      memberUserIds,
      recipientIds,
      authorName: fullNameOrNull(msg.author) ?? '',
      // chat.type в БД — колонка String; перечисление живёт в коде (CHAT_TYPES).
      chatType: chatType as ChatType,
      preview: this.toPreview(msg).text,
    };
    this.events.emit('messenger.message.created', wsPayload, 'messenger');
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
    // Аналитика: факт отправки — без текста; упоминание — только признак наличия токена `@[…](id)`
    await this.analytics.track(null, 'messenger.message.sent', { kind: 'text', hasMention: /@\[[^\]]+\]\([0-9a-f-]{36}\)/i.test(content), chatKind: chatType as ChatType });

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
    await this.analytics.track(null, 'messenger.message.sent', {
      kind: files.length > 0 && files.every((f) => f.kind === 'audio') ? 'voice' : 'attachment',
      hasMention: !!content && /@\[[^\]]+\]\([0-9a-f-]{36}\)/i.test(content),
      chatKind: chatType as ChatType,
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
    if (!msg) throw notFound('chat.messageNotFound');
    // Access first: a user removed from the chat (Hard Revoke) loses edit rights even
    // on their own old messages. Authorship alone is not enough.
    await this.assertAccess(userId, msg.chatId);
    // Пол ленты: сообщение старше — не правится; цитата старше — в ответе и сокете как удалённая
    const floor = await this.chatFloor(msg.chatId);
    if (floor > 0 && msg.seq < floor) throw notFound('chat.messageNotFound');
    if (msg.authorId !== userId) throw forbidden('chat.editOwnOnly');
    if (msg.deletedAt) throw badRequest('chat.messageDeleted');
    // attachment: редактируется только подпись (она и живёт в content — К-1)
    if (msg.type !== 'text' && msg.type !== 'attachment') {
      throw badRequest('chat.messageNotEditable');
    }

    // Под заморозкой оригинал уходит в hold store той же транзакцией (человек не блокируется)
    // Переход status-guarded: удаление (или «стереть все мои сообщения»), случившееся между
    // чтением и записью, не получает текст обратно в томбстоун
    const updated = await this.db.$transaction(async (tx) => {
      await this.holds.preserve(tx, 'Message', msg.id, messageSnapshot(msg));
      const { count } = await tx.message.updateMany({ where: { id: messageId, deletedAt: null }, data: { content, editedAt: new Date() } });
      if (!count) throw badRequest('chat.messageDeleted');
      return tx.message.findUniqueOrThrow({ where: { id: messageId }, include: MESSAGE_REPLY_INCLUDE });
    });
    await this.broadcastUpdate(updated, 'messenger.message.updated', floor);

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

    return this.toMessage(updated, userId, 0, 0, undefined, true, floor);
  }

  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const msg = await this.db.message.findUnique({ where: { id: messageId } });
    if (!msg) throw notFound('chat.messageNotFound');
    // Access first (see editMessage): removal from the chat revokes delete rights too.
    await this.assertAccess(userId, msg.chatId);
    if (msg.authorId !== userId) throw forbidden('chat.deleteOwnOnly');
    // Вне срока чата сообщение уже скрыто и уйдёт раннером — удалять нечего
    if (msg.deletedAt || (await this.expiredMessage(msg))) return;

    // Томбстоун несёт только id, тип и момент: текст и payload (имя, размер, превью файла) — NULL.
    // Под заморозкой оригинал уходит в hold store той же транзакцией (человек не блокируется)
    const updated = await this.db.$transaction(async (tx) => {
      await this.holds.preserve(tx, 'Message', msg.id, messageSnapshot(msg));
      return tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), content: null, payload: Prisma.DbNull },
        include: { author: { select: USER_LITE } },
      });
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
      where: { id: taskId, deletedAt: null },
      select: { creatorId: true, participants: { select: { userId: true, role: true } } },
    });
    if (!task) return map;
    map.set(task.creatorId, this.i18n.translate(TASK_ROLE_LABEL_KEYS.creator));
    for (const p of task.participants) {
      // Creator label wins if the creator is also a participant.
      if (map.has(p.userId)) continue;
      const key = TASK_ROLE_LABEL_KEYS[p.role];
      map.set(p.userId, key ? this.i18n.translate(key) : null);
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
    map.set(order.sellerId, this.i18n.translate(ORDER_ROLE_LABEL_KEYS.seller));
    if (!map.has(order.buyerId)) map.set(order.buyerId, this.i18n.translate(ORDER_ROLE_LABEL_KEYS.buyer));
    for (const c of order.contributions) {
      if (map.has(c.contributorId)) continue;
      map.set(c.contributorId, this.i18n.translate(ORDER_ROLE_LABEL_KEYS.contributor));
    }
    return map;
  }

  /** userId → event-role label in the VIEWER’s language, for an event chat. */
  private async eventRoleLabels(eventId: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const event = await this.db.calendarEvent.findUnique({
      where: { id: eventId, deletedAt: null },
      select: { userId: true, participants: { select: { userId: true } } },
    });
    if (!event) return map;
    map.set(event.userId, this.i18n.translate(EVENT_ROLE_LABEL_KEYS.organizer));
    for (const p of event.participants) {
      if (map.has(p.userId)) continue;
      map.set(p.userId, this.i18n.translate(EVENT_ROLE_LABEL_KEYS.attendee));
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
      map.set(
        p.userId,
        this.i18n.translate(OFFICE_ROOM_ROLE_LABEL_KEYS[p.role === 'host' ? 'host' : 'participant']),
      );
    }
    return map;
  }

  private async broadcastUpdate(
    msg: any,
    type: 'messenger.message.updated' | 'messenger.message.deleted',
    /** Пол ленты чата: цитата старше уходит в сокет как удалённая (вне срока чата) */
    floor = 0,
  ): Promise<void> {
    const memberUserIds = await this.memberIds(msg.chatId);
    const wsPayload: WsMessageUpdated = {
      chatId: msg.chatId,
      message: this.toMessage(msg, '__broadcast__', 0, 0, undefined, true, floor),
      memberUserIds,
    };
    this.events.emit(type, wsPayload, 'messenger');
  }

  private async emitReceipt(
    chatId: string,
    userId: string,
    deliveredSeq: number,
    lastReadSeq: number,
  ): Promise<void> {
    const memberUserIds = await this.memberIds(chatId);
    const wsPayload: WsReceipt = { chatId, userId, deliveredSeq, lastReadSeq, memberUserIds };
    this.events.emit('messenger.receipt', wsPayload, 'messenger');
  }

  /**
   * Текст системной плашки в языке ЗАПРОСА.
   *
   * Плашки — проекция записей core/chatter, и запись хранит СТРУКТУРУ (актёр,
   * changes, payload). Синк кладёт её в `payload.chatter` рядом со снимком
   * `payload.text` в языке-источнике. Здесь структура снова превращается в текст —
   * поэтому лента читается по-казахски у одного человека и по-английски у другого,
   * включая плашки, написанные год назад. Нет структуры (сообщение до этой
   * версии, плашка не из хроники) → снимок как есть.
   */
  private systemText(payload: unknown): string | null {
    const p = (payload ?? null) as Record<string, unknown> | null;
    if (!p) return null;
    const snapshot = typeof p.text === 'string' ? p.text : null;
    const typeKey = typeof p.eventType === 'string' ? p.eventType : null;
    // Плашка канала `chat` движка уведомлений: текст собирается в языке читателя из
    // type+payload события (render-at-read), снимок — фолбэк ушедшего типа.
    if (typeKey === 'notification') {
      const n = p.notification as { type?: string; payload?: Record<string, unknown> } | undefined;
      if (n?.type) {
        const r = this.notificationsRenderer.render(this.i18n.locale, n.type, n.payload ?? {}, { snapshot: { title: snapshot } });
        return r.body ? `${r.title}\n${r.body}` : r.title;
      }
      return snapshot;
    }
    const source = p.chatter as ChatterEntryLike | undefined;
    // Плашки сервисов кладут ключ типа отдельным полем: имя события шины
    // (`office.room.created`) не равно ключу записи хроники (`office.room_created`).
    const key = typeof p.chatterTypeKey === 'string' ? p.chatterTypeKey : typeKey;
    if (!key || !source) return snapshot;
    const locale = this.i18n.locale;
    const rendered = renderChatter(
      this.i18n.forLocale(locale),
      key,
      source,
      this.i18n.format(locale),
    );
    // renderChatter возвращает сам typeKey, если типа нет в каталоге — снимок честнее.
    return rendered === key ? snapshot : rendered;
  }

  private toMessage(
    r: any,
    viewerId: string,
    peerDeliveredSeq = 0,
    peerReadSeq = 0,
    labelMap?: Map<string, string | null>,
    showStatus = true,
    /** Пол ленты чата: цитата старше — как удалённая (вне срока чата) */
    floor = 0,
  ): ChatMessage {
    const mine = r.authorId === viewerId;
    let status: MessageDeliveryStatus | undefined;
    if (mine && showStatus) {
      status = peerReadSeq >= r.seq ? 'read' : peerDeliveredSeq >= r.seq ? 'delivered' : 'sent';
    }
    const deleted = !!r.deletedAt;
    let payload = deleted ? null : ((r.payload as Record<string, unknown> | null) ?? null);
    if (payload && r.type === 'system') {
      // Перерисовываем ИМЕННО payload.text: его читают и веб (SystemPlaque), и
      // mobile — одна точка вместо второго поля рядом.
      const text = this.systemText(payload);
      if (text !== null && text !== payload.text) payload = { ...payload, text };
    }
    return {
      id: r.id,
      chatId: r.chatId,
      authorId: r.authorId ?? null,
      authorName: r.author ? fullName(r.author) : null,
      authorAvatar: r.author?.avatar ?? null,
      authorRoleTag: r.authorId ? labelMap?.get(r.authorId) ?? null : null,
      type: r.type,
      content: deleted ? null : r.content ?? null,
      payload,
      seq: r.seq,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      mine,
      status,
      replyTo: r.replyTo ? this.toReplyPreview(r.replyTo, floor) : null,
    };
  }

  /** Compact preview of a quoted message (Phase 7). Null text for a deleted quote or one past the chat retention. */
  private toReplyPreview(rt: any, floor = 0): MessageReplyPreview {
    const deleted = !!rt.deletedAt || (floor > 0 && typeof rt.seq === 'number' && rt.seq < floor);
    let text: string | null;
    if (deleted) text = null;
    else if (rt.type === 'text') text = rt.content ?? '';
    else if (rt.type === 'attachment') text = rt.content || this.attachmentPreviewText(rt.payload);
    else if (rt.type === 'system') text = this.systemText(rt.payload) ?? this.i18n.translate('messenger.systemPlaque.unknown');
    else text = (rt.payload?.title as string) ?? this.i18n.translate('messenger.cardFallback');
    return {
      id: rt.id,
      authorName: rt.author ? fullName(rt.author) : null,
      text,
      deleted,
    };
  }

  /**
   * Превью attachment-сообщения без подписи. ЧТО показать решает общая функция
   * (одна точка с веб-фолбэком), слово даёт каталог в языке запроса.
   */
  private attachmentPreviewText(payload: unknown): string {
    const kind = attachmentPreviewKind(
      (payload as { files?: Array<{ kind?: string; profile?: string }> } | null)?.files,
    );
    return this.i18n.translate(`messenger.attachmentPreview.${kind.key}`, { n: kind.count });
  }

  private toPreview(r: any): MessagePreview {
    const deleted = !!r.deletedAt;
    let text: string | null;
    if (deleted) text = this.i18n.translate('messenger.list.messageDeleted');
    else if (r.type === 'text') text = r.content ?? '';
    else if (r.type === 'attachment') text = r.content || this.attachmentPreviewText(r.payload);
    else if (r.type === 'system') text = this.systemText(r.payload) ?? this.i18n.translate('messenger.systemPlaque.unknown');
    else text = (r.payload?.title as string) ?? this.i18n.translate('messenger.cardFallback');
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
