import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OfficeRoom, Prisma } from '@prisma/client';
import {
  CreateOfficeRoomInput,
  InviteOfficeRoomInput,
  OFFICE_LIMITS,
  OfficeHistoryPageDto,
  OfficeRoomDto,
  OfficeRoomPersonDto,
  OfficeRoomRole,
  WORKSPACE_ROLE_RANK,
  WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RedisService } from '../../shared/redis/redis.service';
import { RolesService } from '../../core/roles/roles.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { CallsRefRegistry } from '../../core/calls/calls-ref.registry';
import { CallsService } from '../../core/calls/calls.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MessengerService } from '../messenger/messenger.service';

const WS_CONTEXT = 'workspace';
/** refType встречи в движке звонков (CallsRefRegistry) и контекстном чате мессенджера */
export const OFFICE_CALL_REF_TYPE = 'office_room';

type RoomRow = OfficeRoom & { participants: Array<{ userId: string; role: string }> };

/**
 * «Виртуальный офис» (B2B) — видеовстречи организации, первый потребитель движка
 * core/calls (v1 — аналог Google Meet: создать встречу, провести собрание;
 * kind='channel' зарезервирован под Discord-фазу). Встреча (OfficeRoom) ≠ созвон
 * (CallSession): room_finished закрывает созвон, ссылка-встреча живёт до «Завершить»
 * (host ∥ manager+) или авто-энда кроном. Гейты — лестница ролей воркспейса (паттерн
 * staff): вся команда (Стажёр+), Подрядчик изолирован. Причастные к встрече
 * (OfficeRoomParticipant: host при создании, participant при приглашении/первом входе) —
 * источник проекции office_room#host|participant → чат встречи + rich card.
 */
@Injectable()
export class OfficeService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly roles: RolesService,
    private readonly accessProjection: AccessProjectionService,
    private readonly callsRegistry: CallsRefRegistry,
    private readonly calls: CallsService,
    private readonly notifications: NotificationsService,
    private readonly messenger: MessengerService,
    private readonly redis: RedisService,
  ) {}

  /** Регистрация refType-резолвера в движке звонков (паттерн FilesRefRegistry). */
  onModuleInit(): void {
    this.callsRegistry.register(OFFICE_CALL_REF_TYPE, {
      // «Войти по ссылке» может вся команда воркспейса (Стажёр+; Подрядчик изолирован)
      canJoin: async (userId, roomId) => {
        const room = await this.db.officeRoom.findUnique({
          where: { id: roomId },
          select: { workspaceId: true, status: true },
        });
        if (!room || room.status !== 'active') return false;
        const role = await this.getRoleOf(userId, room.workspaceId);
        return !!role && role !== 'contractor';
      },
      canModerate: async (userId, roomId) => {
        const room = await this.db.officeRoom.findUnique({
          where: { id: roomId },
          select: { workspaceId: true, createdById: true },
        });
        if (!room) return false;
        return this.canManageRoom(userId, room.workspaceId, room.createdById);
      },
      // Первый вход по ссылке делает пользователя участником (чат/карточка — синхронно,
      // шина at-most-once для этого не годится)
      onJoinAuthorized: async (userId, roomId) => {
        await this.materializeParticipant(roomId, userId);
      },
      resolveWorkspaceId: async (roomId) => {
        const room = await this.db.officeRoom.findUnique({
          where: { id: roomId },
          select: { workspaceId: true },
        });
        return room?.workspaceId ?? null;
      },
    });
  }

  // ============================================================
  // Чтение
  // ============================================================

  async list(userId: string, workspaceId: string): Promise<OfficeRoomDto[]> {
    await this.assertTeamMember(userId, workspaceId);
    const rooms = await this.db.officeRoom.findMany({
      where: { workspaceId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      // Только МОЯ строка участия (для myRole) — не тянем всех участников всех встреч
      // на каждый поллинг (список обновляется каждые OFFICE_LIMITS.listPollMs).
      include: { participants: { where: { userId }, select: { userId: true, role: true } } },
      take: 100,
    });
    return this.serializeMany(userId, rooms);
  }

  async getOne(userId: string, workspaceId: string, roomId: string): Promise<OfficeRoomDto> {
    await this.assertTeamMember(userId, workspaceId);
    const room = await this.db.officeRoom.findFirst({
      where: { id: roomId, workspaceId },
      include: { participants: { where: { userId }, select: { userId: true, role: true } } },
    });
    if (!room) throw new NotFoundException('Встреча не найдена');
    const [dto] = await this.serializeMany(userId, [room]);
    return dto;
  }

  /**
   * История завершённых встреч (cursor-пагинация по endedAt/id) — вход в чат встречи,
   * дом будущих транскрипций и протоколов собраний (Ф3 запись). Список видит вся
   * команда; сам чат открывается только участникам (office_room.view).
   */
  async history(userId: string, workspaceId: string, cursor?: string): Promise<OfficeHistoryPageDto> {
    await this.assertTeamMember(userId, workspaceId);
    const take = OFFICE_LIMITS.historyPageSize;
    const rooms = await this.db.officeRoom.findMany({
      where: { workspaceId, status: 'ended' },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: take + 1,
      include: { participants: { where: { userId }, select: { userId: true, role: true } } },
    });
    const page = rooms.slice(0, take);
    const items = await this.serializeMany(userId, page);
    return { items, nextCursor: rooms.length > take ? page[page.length - 1].id : null };
  }

  // ============================================================
  // Мутации
  // ============================================================

  async create(userId: string, workspaceId: string, input: CreateOfficeRoomInput): Promise<OfficeRoomDto> {
    await this.assertTeamMember(userId, workspaceId);
    const name = input.name?.trim() || `Встреча ${formatMeetingStamp(new Date())}`;
    const room = await this.db.$transaction(async (tx) => {
      const created = await tx.officeRoom.create({
        data: { workspaceId, name, createdById: userId },
      });
      await tx.officeRoomParticipant.create({
        data: { roomId: created.id, userId, role: 'host' },
      });
      return created;
    });
    await this.accessProjection.resyncOfficeRoomRoles(room.id);
    this.events.emit(
      'office.room.created',
      { roomId: room.id, workspaceId, byUserId: userId, name: room.name },
      'office',
    );
    return this.getOne(userId, workspaceId, room.id);
  }

  /**
   * Пригласить сотрудников: только члены команды ЭТОГО воркспейса (Подрядчик и чужаки
   * молча отсеиваются). Новые становятся participant (проекция + члены чата), уведомление
   * получают все валидные адресаты — «зовут на встречу сейчас».
   */
  async invite(
    userId: string,
    workspaceId: string,
    roomId: string,
    input: InviteOfficeRoomInput,
  ): Promise<{ invited: number }> {
    await this.assertTeamMember(userId, workspaceId);
    const room = await this.db.officeRoom.findFirst({
      where: { id: roomId, workspaceId },
      select: { id: true, name: true, status: true, participants: { select: { userId: true } } },
    });
    if (!room) throw new NotFoundException('Встреча не найдена');
    if (room.status !== 'active') throw new BadRequestException('Встреча завершена — приглашать некуда');

    const targetIds = [...new Set(input.userIds)].filter((id) => id !== userId);
    if (!targetIds.length) return { invited: 0 };
    const memberRows = await this.db.userRole.findMany({
      where: {
        userId: { in: targetIds },
        context: WS_CONTEXT,
        tenantId: workspaceId,
        isActive: true,
        role: { notIn: ['contractor'] },
      },
      select: { userId: true },
    });
    const validIds = [...new Set(memberRows.map((r) => r.userId))];
    if (!validIds.length) return { invited: 0 };

    const already = new Set(room.participants.map((p) => p.userId));
    const newIds = validIds.filter((id) => !already.has(id));
    if (newIds.length) {
      await this.db.officeRoomParticipant.createMany({
        data: newIds.map((uid) => ({ roomId, userId: uid, role: 'participant' })),
        skipDuplicates: true,
      });
      await this.accessProjection.resyncOfficeRoomRoles(roomId);
      await this.messenger.syncOfficeRoomChatMembers(roomId);
    }

    const byName = await this.nameOf(userId);
    await Promise.all(
      validIds.map((uid) =>
        this.notifications.notify(
          uid,
          'office.meeting.invited',
          { byName, roomName: room.name, workspaceId },
          { actionUrl: `/workspaces/${workspaceId}/office/${roomId}` },
        ),
      ),
    );
    this.events.emit(
      'office.room.invited',
      { roomId, workspaceId, byUserId: userId, userIds: validIds },
      'office',
    );
    return { invited: validIds.length };
  }

  /** Завершить встречу (host ∥ manager+): гасит живой созвон, ссылка перестаёт работать. */
  async end(userId: string, workspaceId: string, roomId: string): Promise<void> {
    await this.assertTeamMember(userId, workspaceId); // не-член (уволенный) → 403
    const room = await this.db.officeRoom.findFirst({
      where: { id: roomId, workspaceId },
      select: { id: true, createdById: true },
    });
    if (!room) throw new NotFoundException('Встреча не найдена');
    if (!(await this.canManageRoom(userId, workspaceId, room.createdById))) {
      throw new ForbiddenException('Завершить встречу может организатор или Менеджер и выше');
    }
    // Сначала ЗАКРЫВАЕМ дверь (status='ended'), потом гасим созвон: иначе в окне между
    // deleteRoom и updateMany опоздавший canJoin видит status='active' и поднимает НОВУЮ
    // сессию, которую endActiveForRef уже не застанет (зомби-звонок в завершённой встрече).
    const done = await this.db.officeRoom.updateMany({
      where: { id: roomId, status: 'active' },
      data: { status: 'ended', endedAt: new Date() },
    });
    if (done.count !== 1) return; // уже завершена (гонка/повтор) — идемпотентность
    await this.calls.endActiveForRef(OFFICE_CALL_REF_TYPE, roomId);
    this.events.emit(
      'office.room.ended',
      { roomId, workspaceId, byUserId: userId, reason: 'manual' },
      'office',
    );
  }

  /**
   * Крон: авто-завершение встреч-«сирот» — без активного созвона дольше
   * OFFICE_LIMITS.autoEndIdleHours (ссылка Meet живёт часы, не дни).
   */
  async autoEndIdle(): Promise<number> {
    const cutoff = new Date(Date.now() - OFFICE_LIMITS.autoEndIdleHours * 3600_000);
    const rooms = await this.db.officeRoom.findMany({
      where: { status: 'active', kind: 'meeting', createdAt: { lt: cutoff } },
      select: { id: true, workspaceId: true },
      take: 100,
    });
    let ended = 0;
    for (const room of rooms) {
      const lastSession = await this.db.callSession.findFirst({
        where: { refType: OFFICE_CALL_REF_TYPE, refId: room.id },
        orderBy: { startedAt: 'desc' },
        select: { status: true, endedAt: true },
      });
      if (lastSession?.status === 'active') continue; // идёт созвон — встреча живая
      if (lastSession?.endedAt && lastSession.endedAt > cutoff) continue; // недавно говорили
      const done = await this.db.officeRoom.updateMany({
        where: { id: room.id, status: 'active' },
        data: { status: 'ended', endedAt: new Date() },
      });
      if (done.count === 1) {
        ended++;
        // Подстраховка: если созвон стартовал между чтением lastSession и updateMany —
        // гасим его (встреча уже помечена ended, вход закрыт).
        await this.calls.endActiveForRef(OFFICE_CALL_REF_TYPE, room.id);
        this.events.emit(
          'office.room.ended',
          { roomId: room.id, workspaceId: room.workspaceId, reason: 'idle' },
          'office',
        );
      }
    }
    return ended;
  }

  /**
   * Каскад увольнения/выхода: снять ВСЕ участия человека во встречах организации (и
   * активных, и завершённых). Иначе строка OfficeRoomParticipant вечно проецирует tuple
   * office_room#participant → чат встречи остаётся доступен бывшему сотруднику на чтение
   * И запись (дом транскрипций/протоколов). Зовётся синхронно из WorkspacesService
   * (шина at-most-once для отзыва доступа не годится). Best-effort по комнатам —
   * ошибка синка одной не блокирует остальные; крон-сверка добьёт.
   */
  async removeAllParticipationsForUser(workspaceId: string, userId: string): Promise<void> {
    const rows = await this.db.officeRoomParticipant.findMany({
      where: { userId, room: { workspaceId } },
      select: { roomId: true },
    });
    if (!rows.length) return;
    const roomIds = [...new Set(rows.map((r) => r.roomId))];
    await this.db.officeRoomParticipant.deleteMany({ where: { userId, roomId: { in: roomIds } } });
    for (const roomId of roomIds) {
      await this.accessProjection.resyncOfficeRoomRoles(roomId).catch(() => undefined);
      await this.messenger.syncOfficeRoomChatMembers(roomId).catch(() => undefined);
    }
  }

  /**
   * Крон-сверка (defense-in-depth к синхронному каскаду): участия людей, которые больше
   * НЕ в команде организации (нет активной workspace-роли), снимаются. Ловит дрейф, если
   * синхронный отзыв при увольнении не долетел (падение процесса и т.п.).
   */
  async reconcileOrphanParticipants(): Promise<number> {
    // Keyset-круг с курсором в Redis: прежний head-scan `take: 5000` БЕЗ orderBy
    // переставал сверять хвост таблицы, как только участий становилось больше потолка —
    // а это единственный backstop к best-effort каскаду увольнения. Прогон = одна
    // страница; следующий продолжает с курсора; конец таблицы → круг заново.
    const CURSOR_KEY = 'office:reconcile:cursor';
    const PAGE = 5000;
    let cursor: string | null = null;
    try {
      cursor = await this.redis.get(CURSOR_KEY);
    } catch {
      /* нет курсора — начинаем с начала */
    }
    const rows = await this.db.officeRoomParticipant.findMany({
      select: { id: true, userId: true, room: { select: { id: true, workspaceId: true } } },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: PAGE,
    });
    try {
      if (rows.length < PAGE) await this.redis.del(CURSOR_KEY);
      else await this.redis.set(CURSOR_KEY, rows[rows.length - 1].id);
    } catch {
      /* курсор — best-effort */
    }
    if (!rows.length) return 0;
    // Собрать активные роли по (workspaceId,userId) одним запросом на воркспейс-множество
    const wsIds = [...new Set(rows.map((r) => r.room.workspaceId))];
    const activeRoles = await this.db.userRole.findMany({
      where: { context: WS_CONTEXT, tenantId: { in: wsIds }, isActive: true, role: { not: 'contractor' } },
      select: { userId: true, tenantId: true },
    });
    const member = new Set(activeRoles.map((r) => `${r.tenantId}:${r.userId}`));
    const orphanRoomIds = new Set<string>();
    for (const r of rows) {
      if (!member.has(`${r.room.workspaceId}:${r.userId}`)) {
        await this.db.officeRoomParticipant
          .deleteMany({ where: { roomId: r.room.id, userId: r.userId } })
          .catch(() => undefined);
        orphanRoomIds.add(r.room.id);
      }
    }
    for (const roomId of orphanRoomIds) {
      await this.accessProjection.resyncOfficeRoomRoles(roomId).catch(() => undefined);
      await this.messenger.syncOfficeRoomChatMembers(roomId).catch(() => undefined);
    }
    return orphanRoomIds.size;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Первый вход по ссылке делает пользователя участником: проекция + члены чата. */
  private async materializeParticipant(roomId: string, userId: string): Promise<void> {
    const existing = await this.db.officeRoomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { id: true },
    });
    if (existing) return;
    try {
      await this.db.officeRoomParticipant.create({ data: { roomId, userId, role: 'participant' } });
    } catch (err) {
      // Гонка двух одновременных входов: unique(roomId,userId) — участник уже есть
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
    await this.accessProjection.resyncOfficeRoomRoles(roomId);
    await this.messenger.syncOfficeRoomChatMembers(roomId);
  }

  private async serializeMany(viewerId: string, rooms: RoomRow[]): Promise<OfficeRoomDto[]> {
    if (!rooms.length) return [];
    const liveByRoom = await this.liveBlocks(rooms.map((r) => r.id));

    const personIds = new Set<string>();
    for (const r of rooms) personIds.add(r.createdById);
    for (const live of liveByRoom.values()) for (const uid of live.participantIds) personIds.add(uid);
    const users = await this.db.user.findMany({
      where: { id: { in: [...personIds] } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const personById = new Map<string, OfficeRoomPersonDto>(users.map((u) => [u.id, u]));

    return rooms.map((room) => {
      const live = liveByRoom.get(room.id) ?? null;
      const my = room.participants.find((p) => p.userId === viewerId);
      return {
        id: room.id,
        workspaceId: room.workspaceId,
        name: room.name,
        kind: room.kind as OfficeRoomDto['kind'],
        status: room.status as OfficeRoomDto['status'],
        createdById: room.createdById,
        createdBy: personById.get(room.createdById) ?? null,
        createdAt: room.createdAt.toISOString(),
        endedAt: room.endedAt ? room.endedAt.toISOString() : null,
        myRole: (my?.role as OfficeRoomRole | undefined) ?? null,
        live: live
          ? {
              sessionId: live.sessionId,
              startedAt: live.startedAt.toISOString(),
              participantCount: live.participantIds.length,
              participants: live.participantIds
                .map((id) => personById.get(id))
                .filter((p): p is OfficeRoomPersonDto => !!p)
                .slice(0, 8),
            }
          : null,
      };
    });
  }

  /**
   * «Идёт сейчас» по комнатам: активные сессии движка звонков + открытые участия
   * (leftAt IS NULL). Офис читает таблицы движка напрямую — carve-out map в CLAUDE.md.
   */
  private async liveBlocks(
    roomIds: string[],
  ): Promise<Map<string, { sessionId: string; startedAt: Date; participantIds: string[] }>> {
    const map = new Map<string, { sessionId: string; startedAt: Date; participantIds: string[] }>();
    if (!roomIds.length) return map;
    const sessions = await this.db.callSession.findMany({
      where: { refType: OFFICE_CALL_REF_TYPE, refId: { in: roomIds }, status: 'active' },
      select: { id: true, refId: true, startedAt: true },
    });
    if (!sessions.length) return map;
    const open = await this.db.callSessionParticipant.findMany({
      where: { sessionId: { in: sessions.map((s) => s.id) }, leftAt: null },
      select: { sessionId: true, userId: true },
    });
    const bySession = new Map<string, string[]>();
    for (const row of open) {
      const arr = bySession.get(row.sessionId) ?? [];
      if (!arr.includes(row.userId)) arr.push(row.userId);
      bySession.set(row.sessionId, arr);
    }
    for (const s of sessions) {
      map.set(s.refId, {
        sessionId: s.id,
        startedAt: s.startedAt,
        participantIds: bySession.get(s.id) ?? [],
      });
    }
    return map;
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Коллега' : 'Коллега';
  }

  private async canManageRoom(userId: string, workspaceId: string, createdById: string): Promise<boolean> {
    // Роль проверяем ПЕРВОЙ: уволенный/разжалованный в contractor организатор теряет
    // модерацию (иначе createdById давал бы ему kick/mute/«Завершить» над живой встречей
    // организации, из которой он уже ушёл).
    const role = await this.getRoleOf(userId, workspaceId);
    if (!role || role === 'contractor') return false;
    if (createdById === userId) return true;
    return (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  }

  private async getRoleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  /** Вся команда (Стажёр+); Подрядчик изолирован — офис ему закрыт (паттерн staff). */
  private async assertTeamMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.getRoleOf(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') {
      throw new ForbiddenException('Подрядчику доступны только его задачи');
    }
    return role;
  }
}

/** «Встреча 17.07 14:30» — имя по умолчанию для мгновенной встречи */
function formatMeetingStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
