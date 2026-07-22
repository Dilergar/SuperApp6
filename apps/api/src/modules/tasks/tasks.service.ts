import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DatabaseService } from '../../shared/database/database.service';
import { ContactsService } from '../contacts/contacts.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EscrowService } from '../wallet/escrow.service';
import { AccessService } from '../../core/access/access.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { Principal } from '../../core/access/access.types';
import { MessengerService } from '../messenger/messenger.service';
import { QuickActionRegistry } from '../../core/quick-actions/quick-actions.registry';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { ChatterService, ChatterLogInput, ChatterTrackSpec } from '../../core/chatter/chatter.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { DI_TOKENS } from '../../shared/di-tokens';
import { fullName } from '../../shared/utils/user-name';
import { Prisma } from '@prisma/client';
import { TASK_PRIORITY_META, TASK_ROLE_LABELS, formatTaskDeadline } from '@superapp/shared';
import type {
  Task as TaskDto,
  TaskParticipant as TaskParticipantDto,
  TaskRole,
  ViewerTaskRole,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilter,
  TaskStats,
  FileDto,
} from '@superapp/shared';

// What every task query pulls so a row can be mapped to the shared Task DTO.
const TASK_INCLUDE = {
  creator: { select: { id: true, firstName: true, lastName: true, avatar: true } },
  participants: {
    include: {
      user: { select: { id: true, firstName: true, lastName: true, avatar: true } },
    },
    orderBy: { addedAt: 'asc' },
  },
  assignedCircle: { select: { id: true, name: true } },
  tags: { select: { name: true } },
  _count: { select: { subtasks: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;
type UserMini = { id: string; firstName: string; lastName: string | null; avatar: string | null };

// Numeric mirror of priority for ORDER BY — the string column sorts lexicographically
// (high < low < medium < urgent), which put high-priority tasks BELOW low-priority ones.
const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

// TASK_ROLE_LABELS — из @superapp/shared (единый источник подписей ролей; локальная
// копия разъезжалась бы с карточкой задачи и мессенджером при правке в shared).

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Отслеживаемые поля хроники (core/chatter): каждое изменённое поле = своя запись
// «было → стало». Сравнение — по display-строкам (см. ChatterService.diffTracked).
type TaskTrackRow = { title: string; priority: string; dueDate: Date | null; allDay: boolean; coinReward: number };
const TASK_TRACK_SPEC: ChatterTrackSpec<TaskTrackRow> = {
  dueDate: {
    typeKey: 'task.deadline_changed',
    label: 'Срок',
    // Формат ДЕТЕРМИНИРОВАН в APP_TIMEZONE (не в TZ окружения сервера) и включает
    // время у не-allDay — иначе прод-UTC зафиксировал бы день раньше и не заметил
    // перенос времени в пределах суток (строка «было → стало» пишется навсегда).
    format: (r) => (r.dueDate ? formatTaskDeadline(r.dueDate, r.allDay) : 'без срока'),
  },
  priority: {
    typeKey: 'task.priority_changed',
    label: 'Приоритет',
    format: (r) =>
      (TASK_PRIORITY_META as Record<string, { label: string }>)[r.priority]?.label ?? r.priority,
  },
  coinReward: {
    typeKey: 'task.reward_changed',
    label: 'Награда',
    format: (r) => `${r.coinReward} 🪙`,
  },
  title: {
    typeKey: 'task.title_changed',
    label: 'Название',
    format: (r) => truncate(r.title, 80),
  },
};


@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private db: DatabaseService,
    private events: EventBusService,
    private notifications: NotificationsService,
    private escrow: EscrowService,
    private access: AccessService,
    private accessProjection: AccessProjectionService,
    private messenger: MessengerService,
    private quickActions: QuickActionRegistry,
    private moduleRef: ModuleRef,
    private contacts: ContactsService,
    private files: FilesService,
    private filesRegistry: FilesRefRegistry,
    private chatter: ChatterService,
    private chatterRegistry: ChatterRefRegistry,
    private workspaceContext: WorkspaceContextService,
  ) {}

  onModuleInit(): void {
    // Phase 7: "Создать задачу" in the chat ＋-menu and a message's corner menu (a message
    // there prefills the task description). Form = modal; result = the task Rich Card in chat.
    this.quickActions.register({
      key: 'task.create',
      label: 'Создать задачу',
      icon: '✓',
      scopes: ['composer', 'message'],
      description: 'Поставить задачу из чата',
    });

    // Вложения задачи (движок файлов): доступ наследуется от задачи; прикрепляют
    // создатель и участники (зеркало assertCanView).
    this.filesRegistry.register('task', {
      canView: async (viewerId, taskId) => {
        const task = await this.db.task.findUnique({
          where: { id: taskId },
          select: { creatorId: true, participants: { select: { userId: true } } },
        });
        if (!task) return false;
        if (await this.access.can(this.user(viewerId), 'task.view', taskId)) return true;
        return task.creatorId === viewerId || task.participants.some((p) => p.userId === viewerId);
      },
      canAttach: async (userId, taskId) => {
        const task = await this.db.task.findUnique({
          where: { id: taskId },
          select: { creatorId: true, participants: { select: { userId: true } } },
        });
        if (!task) return false;
        return this.isCreatorOrParticipant(task, userId);
      },
    }, { allowedProfiles: ['chat_attachment', 'document', 'voice_message', 'generic'] });

    // Хроника задачи (core/chatter): «видишь задачу → видишь её хронику»
    // (тот же предикат, что у вложений).
    this.chatterRegistry.register('task', {
      canView: async (viewerId, taskId) => {
        const task = await this.db.task.findUnique({
          where: { id: taskId },
          select: { creatorId: true, participants: { select: { userId: true } } },
        });
        if (!task) return false;
        if (await this.access.can(this.user(viewerId), 'task.view', taskId)) return true;
        return this.isCreatorOrParticipant(task, viewerId);
      },
    });
  }

  /** Постановщик или любой участник задачи (единый предикат вложений/чата) */
  private isCreatorOrParticipant(
    task: { creatorId: string; participants: { userId: string }[] },
    userId: string,
  ): boolean {
    return task.creatorId === userId || task.participants.some((p) => p.userId === userId);
  }

  /**
   * Отмена задачи-исполнения магазином ВНУТРИ его транзакции (возврат заказа «в работе»):
   * статус → cancelled + запись хроники task.cancelled (иначе прямой updateMany в shop
   * проходил мимо хроники). Права проверил вызывающий (владелец заказа); плашку проецирует
   * джоб core/jobs, поставленный хроникой в этой же транзакции. Идемпотентно: терминальную
   * задачу не трогает.
   */
  async cancelFulfilmentTaskTrusted(
    tx: Prisma.TransactionClient,
    taskId: string,
    actorId: string,
  ): Promise<void> {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: { title: true, workspaceId: true, status: true },
    });
    if (!task || task.status === 'done' || task.status === 'cancelled') return;
    const claimed = await tx.task.updateMany({
      where: { id: taskId, status: task.status },
      data: { status: 'cancelled' },
    });
    if (claimed.count === 0) return;
    await this.chatter.log(tx, {
      refType: 'task',
      refId: taskId,
      workspaceId: task.workspaceId,
      actorId,
      actorName: fullName(await this.userMini(actorId)),
      typeKey: 'task.cancelled',
      payload: { taskTitle: task.title },
    });
  }

  // ============================================================
  // Вложения задачи (FileLink refType='task')
  // ============================================================

  async listAttachments(userId: string, taskId: string): Promise<FileDto[]> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      select: { creatorId: true, participants: { select: { userId: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    await this.assertCanView(userId, taskId, task);
    return (await this.files.listLinked('task', [taskId])).get(taskId) ?? [];
  }

  async attachFile(userId: string, taskId: string, fileId: string): Promise<FileDto[]> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      select: { creatorId: true, participants: { select: { userId: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (!this.isCreatorOrParticipant(task, userId)) {
      throw new ForbiddenException('Прикреплять файлы могут постановщик и участники');
    }
    await this.files.getOwnedReadyFiles(userId, [fileId]); // ready + uploader === userId
    await this.files.linkFile(userId, fileId, 'task', taskId);
    return (await this.files.listLinked('task', [taskId])).get(taskId) ?? [];
  }

  async removeAttachment(userId: string, taskId: string, fileId: string): Promise<void> {
    // unlinkAndReap отвяжет ИМЕННО эту связь и прибёрет файл лишь если она реально была
    // снята — передача чужого/непривязанного fileId больше не удаляет непричастный файл.
    await this.files.unlinkAndReap(userId, fileId, 'task', taskId);
  }

  private user(id: string): Principal {
    return { type: 'user', id };
  }

  // ============================================================
  // Helpers: social-graph validation & group expansion
  // ============================================================

  /** Throw unless every id is a confirmed contact AND not blocked (shared gate in Contacts). */
  private async assertInEnvironment(ownerId: string, ids: string[]): Promise<void> {
    await this.contacts.assertReachable(ownerId, ids, 'Назначать можно только людей из вашего окружения');
  }

  /** Resolve a Группа (Circle) owned by `ownerId` into the member user ids. */
  private async resolveCircleMemberIds(ownerId: string, circleId: string): Promise<string[]> {
    const circle = await this.db.circle.findUnique({
      where: { id: circleId },
      include: {
        memberships: {
          include: { contactLink: { select: { userAId: true, userBId: true } } },
        },
      },
    });
    if (!circle || circle.ownerId !== ownerId) {
      throw new ForbiddenException('Группа не найдена');
    }
    const ids = circle.memberships.map((m) =>
      m.contactLink.userAId === ownerId ? m.contactLink.userBId : m.contactLink.userAId,
    );
    return [...new Set(ids)];
  }

  // ============================================================
  // Create
  // ============================================================

  async createTask(
    userId: string,
    data: CreateTaskRequest,
    // origin — метка источника задачи (напр. 'process'): попадает в payload события
    // task.created, чтобы триггеры процессов пропускали self-события (анти-runaway A4).
    opts: { skipEnvironmentChecks?: boolean; origin?: string } = {},
  ): Promise<TaskDto> {
    if (data.parentId) {
      const parent = await this.db.task.findUnique({ where: { id: data.parentId } });
      const isParticipant = parent
        ? await this.db.taskParticipant.count({
            where: { taskId: parent.id, userId },
          })
        : 0;
      if (!parent || (parent.creatorId !== userId && isParticipant === 0)) {
        throw new ForbiddenException('Родительская задача не найдена');
      }
    }

    const reward = data.coinReward ?? 0;
    // role wins on overlap: executor > co_executor > observer
    const roleByUser = new Map<string, TaskRole>();
    const setRole = (id: string, role: TaskRole) => {
      const rank = { executor: 3, co_executor: 2, observer: 1 } as const;
      const cur = roleByUser.get(id);
      if (!cur || rank[role] > rank[cur]) roleByUser.set(id, role);
    };

    let assignedCircleId: string | null = null;

    if (data.assignedCircleId) {
      const memberIds = await this.resolveCircleMemberIds(userId, data.assignedCircleId);
      if (memberIds.length === 0) {
        throw new BadRequestException('В выбранной группе нет участников');
      }
      assignedCircleId = data.assignedCircleId;
      for (const id of memberIds) setRole(id, 'co_executor');
    } else if (data.executorId) {
      if (!opts.skipEnvironmentChecks) await this.assertInEnvironment(userId, [data.executorId]);
      setRole(data.executorId, 'executor');
      if (data.coExecutorIds?.length) {
        if (!opts.skipEnvironmentChecks) await this.assertInEnvironment(userId, data.coExecutorIds);
        for (const id of data.coExecutorIds) setRole(id, 'co_executor');
      }
    }
    // else: self-task — no participants, no acceptance step.

    // Вложения «с порога» (из модалки создания): предвалидация ДО транзакции —
    // файлы готовы и принадлежат создателю (движок бросит 400), линковка внутри tx.
    const attachmentFileIds = data.attachmentFileIds ?? [];
    if (attachmentFileIds.length) {
      await this.files.getOwnedReadyFiles(userId, attachmentFileIds);
    }

    if (data.observerIds?.length) {
      if (!opts.skipEnvironmentChecks) await this.assertInEnvironment(userId, data.observerIds);
      for (const id of data.observerIds) setRole(id, 'observer');
    }

    const participantsCreate = [...roleByUser.entries()].map(([uid, role]) => ({
      userId: uid,
      role,
      rewardCoins: role === 'observer' ? 0 : reward,
    }));

    const workerIds = participantsCreate
      .filter((p) => p.role !== 'observer')
      .map((p) => p.userId);

    // Create the task and freeze the per-worker reward atomically. If the creator has no
    // currency or not enough coins, holdForWorkers throws → the whole creation rolls back
    // (you can't post a rewarded task without the coins).
    const task = await this.db.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          title: data.title,
          description: data.description,
          priority: data.priority || 'medium',
          priorityRank: PRIORITY_RANK[data.priority || 'medium'] ?? 2,
          dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
          startDate: data.startDate ? new Date(data.startDate) : undefined,
          allDay: data.allDay ?? false,
          // «Входящие»: только «голый» quick-add себе. Срок/родитель/участники значат,
          // что задача уже разобрана; inbox-сабтаск к тому же был бы невидим в списках
          // (глобальный фильтр parentId: null).
          inbox:
            (data.inbox ?? false) &&
            !data.dueDate &&
            !data.parentId &&
            participantsCreate.length === 0,
          reminderAt: data.reminderAt ? new Date(data.reminderAt) : undefined,
          recurrenceRule: data.recurrenceRule,
          creatorId: userId,
          assignedCircleId,
          parentId: data.parentId,
          coinReward: reward,
          coinPenalty: data.coinPenalty ?? 0,
          giftRewardId: data.giftRewardId,
          workspaceId: data.workspaceId,
          tags: data.tags?.length ? { create: data.tags.map((name) => ({ name })) } : undefined,
          participants: participantsCreate.length ? { create: participantsCreate } : undefined,
        },
        include: TASK_INCLUDE,
      });
      await this.freezeReward(tx, created.id, userId, workerIds, reward);
      if (attachmentFileIds.length) {
        await this.files.linkManyInTx(tx, userId, attachmentFileIds, 'task', created.id);
      }

      // Хроника (core/chatter, в этой же транзакции): создание + назначение.
      // Плашка «назначил(а)» — только при реальных получателях (как сегодняшний emit).
      const creatorName = fullName(created.creator);
      const chatterEntries: ChatterLogInput[] = [
        {
          refType: 'task',
          refId: created.id,
          workspaceId: created.workspaceId,
          actorId: userId,
          actorName: creatorName,
          typeKey: 'task.created',
          payload: { taskTitle: created.title },
        },
      ];
      if (participantsCreate.length > 0) {
        const hasRecipients = participantsCreate.some((p) => p.userId !== userId);
        chatterEntries.push({
          refType: 'task',
          refId: created.id,
          workspaceId: created.workspaceId,
          actorId: userId,
          actorName: creatorName,
          typeKey: 'task.assigned',
          payload: { taskTitle: created.title },
          chatPost: hasRecipients,
        });
      }
      await this.chatter.logMany(tx, chatterEntries);

      return created;
    });

    // Phase 3: mirror this task's participant roles into the access engine (best-effort).
    await this.accessProjection.resyncTaskRoles(task.id);
    // Keep the task chat's materialized members in sync (no-op until the chat exists).
    await this.messenger.syncTaskChatMembers(task.id);

    // Calendar integration (existing contract). source — метка происхождения (A4):
    // задачи, созданные процессом (origin='process'), не перезапускают процессы.
    this.events.emit(
      'task.created',
      { taskId: task.id, creatorId: userId, title: task.title, dueDate: data.dueDate, addToCalendar: data.addToCalendar, source: opts.origin },
      'tasks',
    );

    // Notify everyone who was put on the task (not the creator).
    const recipientIds = participantsCreate.map((p) => p.userId).filter((id) => id !== userId);
    if (recipientIds.length > 0) {
      await this.notifications.emitEvent(
        'task.assigned',
        { taskId: task.id, taskTitle: task.title, byUserId: userId, byName: fullName(task.creator), recipientIds },
        'tasks',
      );
    }

    return this.toDto(task, userId);
  }

  // ============================================================
  // Read
  // ============================================================

  /**
   * Id задач, где зритель — участник (индексная выборка task_participants[userId,…]).
   * Зачем: предикат видимости `OR(creatorId, participants.some)` компилируется в
   * `creator_id = $1 OR EXISTS(…)` — Postgres НЕ строит BitmapOr между колонкой и
   * коррелированным EXISTS и уходит в скан всей таблицы tasks (перф-ревью 2026-07-18).
   * `OR(creatorId, id IN (…))` даёт два индексных пути; список ограничен реальным
   * участием пользователя.
   */
  private async myParticipantTaskIds(userId: string): Promise<string[]> {
    const rows = await this.db.taskParticipant.findMany({
      where: { userId },
      select: { taskId: true },
    });
    return rows.map((r) => r.taskId);
  }

  /** Индексируемый предикат «я вижу задачу» (создатель ∨ участник по id-списку). */
  private visibilityWhere(userId: string, participantTaskIds: string[]): Prisma.TaskWhereInput {
    return { OR: [{ creatorId: userId }, { id: { in: participantTaskIds } }] };
  }

  async getTasks(userId: string, filters: TaskFilter & { parentId?: string | null }) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const and: Prisma.TaskWhereInput[] = [
      this.visibilityWhere(userId, await this.myParticipantTaskIds(userId)),
    ];

    // Subtasks are hidden from the inbox unless a specific parent is requested.
    const parentId = filters.parentId === undefined ? null : filters.parentId;

    if (filters.status?.length) and.push({ status: { in: filters.status } });
    if (filters.priority?.length) and.push({ priority: { in: filters.priority } });
    if (filters.workspaceId !== undefined) and.push({ workspaceId: filters.workspaceId });

    if (filters.role) {
      if (filters.role === 'creator') and.push({ creatorId: userId });
      else and.push({ participants: { some: { userId, role: filters.role } } });
    }

    this.applySmartList(filters.smartList, userId, and);

    if (filters.dueDateFrom || filters.dueDateTo) {
      const due: Prisma.DateTimeFilter = {};
      if (filters.dueDateFrom) due.gte = new Date(filters.dueDateFrom);
      if (filters.dueDateTo) due.lte = new Date(filters.dueDateTo);
      and.push({ dueDate: due });
    }

    if (filters.search) {
      and.push({
        OR: [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.TaskWhereInput = { parentId, AND: and };

    const [tasks, total] = await Promise.all([
      this.db.task.findMany({
        where,
        include: TASK_INCLUDE,
        orderBy: [{ priorityRank: 'desc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.db.task.count({ where }),
    ]);

    return {
      data: tasks.map((t) => this.toDto(t, userId)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private applySmartList(
    smartList: TaskFilter['smartList'],
    userId: string,
    and: Prisma.TaskWhereInput[],
  ) {
    if (!smartList) return;
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const open = { notIn: ['done', 'cancelled'] };

    switch (smartList) {
      case 'inbox':
        // «Входящие» — личная разборная папка: только МОИ quick-add записи.
        // Выполненные покидают Входящие сами (флаг не снимается — история честная).
        and.push({ inbox: true, creatorId: userId, status: open });
        break;
      case 'today':
        and.push({ status: open, dueDate: { gte: startOfToday, lte: endOfToday } });
        break;
      case 'upcoming':
        and.push({ status: open, dueDate: { gt: endOfToday } });
        break;
      case 'overdue':
        // Todoist-семантика: задача «весь день» на сегодня НЕ просрочена до конца дня
        // (иначе висела бы в «Просроченных» с 00:00); задача со временем — просрочена
        // с момента срока.
        and.push({
          status: open,
          OR: [
            { allDay: false, dueDate: { lt: now } },
            { allDay: true, dueDate: { lt: startOfToday } },
          ],
        });
        break;
      case 'assigned_to_me':
        and.push({ participants: { some: { userId, role: { in: ['executor', 'co_executor'] } } } });
        break;
      case 'created_by_me':
        and.push({ creatorId: userId });
        break;
      case 'on_review':
        // Tasks I set that are waiting for my acceptance.
        and.push({ creatorId: userId, participants: { some: { status: 'submitted' } } });
        break;
    }
  }

  /**
   * Счётчики смарт-листов — бейджи сайдбара и карточки «Обзора». Переиспользует
   * applySmartList, чтобы предикаты видимости/списков жили в одном месте (нет дрейфа
   * между списком и его цифрой). assignedToMe/createdByMe — только ОТКРЫТЫЕ задачи
   * (бейдж = «требует внимания»), в отличие от одноимённых полных списков.
   */
  async getStats(userId: string): Promise<TaskStats> {
    // Один raw-проход вместо 7 COUNT'ов с OR+EXISTS-предикатом (тот план — скан всей
    // таблицы tasks; этот эндпоинт веб поллит раз в 60с с каждой открытой вкладки /tasks).
    // CTE «мои задачи» = UNION двух индексных выборок (creator_id / task_participants),
    // счётчики — COUNT(*) FILTER по этому ограниченному набору. Семантика каждого
    // фильтра зеркалит applySmartList — менять только синхронно.
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    // $queryRaw обходит chokepoint-скоуп ($extends действует только на model-API) —
    // зеркалим его руками: активная организация в ALS → счётчики только её задач.
    const wsId = this.workspaceContext.activeWorkspaceId;
    const wsFilter = wsId ? Prisma.sql`AND workspace_id = ${wsId}` : Prisma.empty;
    const wsFilterT = wsId ? Prisma.sql`AND t.workspace_id = ${wsId}` : Prisma.empty;

    const rows = await this.db.$queryRaw<
      Array<{
        inbox: number;
        today: number;
        overdue: number;
        upcoming: number;
        assigned_to_me: number;
        created_by_me: number;
        on_review: number;
      }>
    >`
      WITH mine AS (
        SELECT id, creator_id, status, due_date, all_day, inbox
        FROM tasks
        WHERE parent_id IS NULL AND creator_id = ${userId} ${wsFilter}
        UNION
        SELECT t.id, t.creator_id, t.status, t.due_date, t.all_day, t.inbox
        FROM tasks t
        JOIN task_participants tp ON tp.task_id = t.id
        WHERE t.parent_id IS NULL AND tp.user_id = ${userId} ${wsFilterT}
      )
      SELECT
        COUNT(*) FILTER (
          WHERE inbox AND creator_id = ${userId} AND status NOT IN ('done','cancelled')
        )::int AS inbox,
        COUNT(*) FILTER (
          WHERE status NOT IN ('done','cancelled')
            AND due_date >= ${startOfToday} AND due_date <= ${endOfToday}
        )::int AS today,
        COUNT(*) FILTER (
          WHERE status NOT IN ('done','cancelled') AND (
            (all_day = false AND due_date < ${now})
            OR (all_day = true AND due_date < ${startOfToday})
          )
        )::int AS overdue,
        COUNT(*) FILTER (
          WHERE status NOT IN ('done','cancelled') AND due_date > ${endOfToday}
        )::int AS upcoming,
        COUNT(*) FILTER (
          WHERE status NOT IN ('done','cancelled') AND EXISTS (
            SELECT 1 FROM task_participants tp
            WHERE tp.task_id = mine.id AND tp.user_id = ${userId}
              AND tp.role IN ('executor','co_executor')
          )
        )::int AS assigned_to_me,
        COUNT(*) FILTER (
          WHERE creator_id = ${userId} AND status NOT IN ('done','cancelled')
        )::int AS created_by_me,
        COUNT(*) FILTER (
          WHERE creator_id = ${userId} AND EXISTS (
            SELECT 1 FROM task_participants tp
            WHERE tp.task_id = mine.id AND tp.status = 'submitted'
          )
        )::int AS on_review
      FROM mine
    `;
    const r = rows[0];

    return {
      inbox: r?.inbox ?? 0,
      today: r?.today ?? 0,
      overdue: r?.overdue ?? 0,
      upcoming: r?.upcoming ?? 0,
      assignedToMe: r?.assigned_to_me ?? 0,
      createdByMe: r?.created_by_me ?? 0,
      onReview: r?.on_review ?? 0,
    };
  }

  async getTask(userId: string, taskId: string): Promise<TaskDto> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: {
        ...TASK_INCLUDE,
        subtasks: { select: { status: true } },
      },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    await this.assertCanView(userId, taskId, task);

    const dto = this.toDto(task, userId);
    dto.subtasksCount = task.subtasks.length;
    dto.subtasksDoneCount = task.subtasks.filter((s) => s.status === 'done').length;
    return dto;
  }

  /**
   * Tasks surfaced on the calendar as a VIRTUAL layer for `userId`: those with a
   * dueDate inside [from, to], plus overdue & unresolved ones (so the client can
   * pin them to today's all-day bar). Read-only; respects the active workspace
   * via the chokepoint. Never copies — single source of truth stays in Tasks.
   */
  async listForCalendar(userId: string, from: Date, to: Date) {
    const now = new Date();
    const tasks = await this.db.task.findMany({
      where: {
        AND: [
          this.visibilityWhere(userId, await this.myParticipantTaskIds(userId)),
          { dueDate: { not: null } },
          {
            OR: [
              { dueDate: { gte: from, lte: to } },
              { dueDate: { lt: now }, status: { notIn: ['done', 'cancelled'] } },
            ],
          },
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        allDay: true,
        coinReward: true,
        creatorId: true,
        participants: { select: { userId: true, role: true } },
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });

    return tasks.map((t) => {
      const dueDate = t.dueDate as Date;
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate,
        allDay: t.allDay,
        overdue: dueDate < now && t.status !== 'done' && t.status !== 'cancelled',
        role: this.viewerRole(userId, t.creatorId, t.participants),
        coinReward: t.coinReward || null,
      };
    });
  }

  // ============================================================
  // Update / delete
  // ============================================================

  async updateTask(userId: string, taskId: string, data: UpdateTaskRequest): Promise<TaskDto> {
    const existing = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: { select: { id: true, userId: true, role: true } } },
    });
    if (!existing) throw new NotFoundException('Задача не найдена');

    const isCreator = existing.creatorId === userId;
    const isWorker = existing.participants.some(
      (p) => p.userId === userId && p.role !== 'observer',
    );
    if (!isCreator && !isWorker) {
      throw new ForbiddenException('Нет доступа к этой задаче');
    }

    // Role / reward edits are creator-only.
    const roleEdit =
      data.executorId !== undefined ||
      data.addCoExecutorIds?.length ||
      data.addObserverIds?.length ||
      data.removeParticipantUserIds?.length ||
      data.coinReward !== undefined;
    if (roleEdit && !isCreator) {
      throw new ForbiddenException('Менять роли и награду может только Постановщик');
    }

    // The per-person reward is fixed once workers are assigned (coins are committed to escrow).
    // Change the team instead; new workers are funded at the original amount.
    if (
      data.coinReward !== undefined &&
      data.coinReward !== existing.coinReward &&
      existing.participants.some((p) => p.role !== 'observer')
    ) {
      throw new BadRequestException(
        'Награду нельзя изменить после назначения исполнителей — отмените задачу или измените состав',
      );
    }

    const patch: Prisma.TaskUpdateInput = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.priority !== undefined) {
      patch.priority = data.priority;
      patch.priorityRank = PRIORITY_RANK[data.priority] ?? 2;
    }
    if (data.allDay !== undefined) patch.allDay = data.allDay;
    if (data.coinReward !== undefined) patch.coinReward = data.coinReward;
    if (data.coinPenalty !== undefined) patch.coinPenalty = data.coinPenalty;
    if (data.dueDate !== undefined) patch.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.startDate !== undefined) patch.startDate = data.startDate ? new Date(data.startDate) : null;
    if (data.reminderAt !== undefined) {
      patch.reminderAt = data.reminderAt ? new Date(data.reminderAt) : null;
      patch.reminderSentAt = null; // re-arm the reminder
    }
    if (data.recurrenceRule !== undefined) patch.recurrenceRule = data.recurrenceRule;

    // «Входящие»: ручное «Разобрано» + авто-уточнение — назначенный срок или исполнитель
    // означает, что запись разобрана (GTD clarify, Todoist-модель).
    if (data.inbox !== undefined) patch.inbox = data.inbox;
    const clarified =
      (data.dueDate !== undefined && data.dueDate !== null) ||
      !!data.executorId ||
      !!data.addCoExecutorIds?.length;
    if (clarified) patch.inbox = false;

    // Direct status moves: starting work, cancelling. Acceptance flow has dedicated endpoints.
    if (data.status !== undefined) {
      if (data.status === 'done' || data.status === 'on_review') {
        throw new BadRequestException('Используйте «сдать» / «принять» для завершения задачи');
      }
      patch.status = data.status;
      if (data.status === 'cancelled' && !isCreator) {
        throw new ForbiddenException('Отменить задачу может только Постановщик');
      }
    }

    // ---- Хроника (core/chatter): диффы «было → стало» + смены состава.
    // Считаются ДО транзакции (нужны старые значения и имена), пишутся В ней.
    const actorName = fullName(await this.userMini(userId));
    const afterRow: TaskTrackRow = {
      title: data.title ?? existing.title,
      priority: data.priority ?? existing.priority,
      dueDate:
        data.dueDate !== undefined
          ? data.dueDate
            ? new Date(data.dueDate)
            : null
          : existing.dueDate,
      allDay: data.allDay ?? existing.allDay,
      coinReward: data.coinReward ?? existing.coinReward,
    };
    const entryBase = {
      refType: 'task' as const,
      refId: taskId,
      workspaceId: existing.workspaceId,
      actorId: userId,
      actorName,
    };
    const chatterEntries: ChatterLogInput[] = this.chatter
      .diffTracked(TASK_TRACK_SPEC, existing, afterRow)
      .map((d) => ({
        ...entryBase,
        typeKey: d.typeKey,
        changes: [d.change],
        payload: { taskTitle: afterRow.title },
      }));
    if (data.description !== undefined && (data.description ?? '') !== (existing.description ?? '')) {
      chatterEntries.push({
        ...entryBase,
        typeKey: 'task.description_changed',
        payload: { taskTitle: afterRow.title },
      });
    }
    if (patch.status === 'cancelled' && existing.status !== 'cancelled') {
      chatterEntries.push({
        ...entryBase,
        typeKey: 'task.cancelled',
        payload: { taskTitle: afterRow.title },
      });
    }
    if (isCreator && roleEdit) {
      const oldExec = existing.participants.find((p) => p.role === 'executor');
      const participantIds = new Set(existing.participants.map((p) => p.userId));
      // Реально снимаемые участники; замена исполнителя логируется своей парой ниже.
      const removedForLog = (data.removeParticipantUserIds ?? []).filter(
        (uid) => participantIds.has(uid) && !(data.executorId !== undefined && uid === oldExec?.userId),
      );
      const nameIds = new Set<string>([
        ...removedForLog,
        ...(data.addCoExecutorIds ?? []),
        ...(data.addObserverIds ?? []),
      ]);
      if (data.executorId !== undefined && oldExec) nameIds.add(oldExec.userId);
      if (data.executorId) nameIds.add(data.executorId);
      const names = new Map(
        (
          await this.db.user.findMany({
            where: { id: { in: [...nameIds] } },
            select: { id: true, firstName: true, lastName: true },
          })
        ).map((u) => [u.id, fullName(u)]),
      );
      const target = (uid: string) => ({ targetUserId: uid, targetName: names.get(uid) ?? 'Пользователь' });

      for (const uid of removedForLog) {
        chatterEntries.push({
          ...entryBase,
          typeKey: 'task.participant_removed',
          payload: { taskTitle: afterRow.title, ...target(uid) },
        });
      }
      if (data.executorId !== undefined) {
        if (oldExec && oldExec.userId !== data.executorId) {
          chatterEntries.push({
            ...entryBase,
            typeKey: 'task.participant_removed',
            payload: { taskTitle: afterRow.title, ...target(oldExec.userId) },
          });
        }
        if (data.executorId && data.executorId !== oldExec?.userId) {
          chatterEntries.push({
            ...entryBase,
            typeKey: 'task.assigned',
            payload: { taskTitle: afterRow.title, ...target(data.executorId) },
          });
        }
      }
      // Только РЕАЛЬНО новые участники: applyRoleEdits — идемпотентный upsert, поэтому
      // повторное добавление уже существующего = no-op, а плашка «добавил(а)» была бы
      // ложью. Уже-назначенный исполнитель (task.assigned выше) тоже не дублируется.
      const isNewMember = (uid: string) => !participantIds.has(uid) && uid !== data.executorId;
      for (const uid of (data.addCoExecutorIds ?? []).filter(isNewMember)) {
        chatterEntries.push({
          ...entryBase,
          typeKey: 'task.participant_added',
          payload: { taskTitle: afterRow.title, ...target(uid), roleLabel: TASK_ROLE_LABELS.co_executor },
        });
      }
      for (const uid of (data.addObserverIds ?? []).filter(isNewMember)) {
        chatterEntries.push({
          ...entryBase,
          typeKey: 'task.participant_added',
          payload: { taskTitle: afterRow.title, ...target(uid), roleLabel: TASK_ROLE_LABELS.observer },
        });
      }
    }

    await this.db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: patch });

      if (patch.status === 'cancelled') {
        await this.escrow.releaseAll(tx, { refType: 'task', refId: taskId }); // refund all frozen / paid reward
      }

      if (data.tags !== undefined) {
        await tx.taskTag.deleteMany({ where: { taskId } });
        if (data.tags.length) {
          await tx.taskTag.createMany({ data: data.tags.map((name) => ({ taskId, name })) });
        }
      }

      if (isCreator) {
        await this.applyRoleEdits(tx, taskId, existing, data);
      }

      await this.chatter.logMany(tx, chatterEntries);
    });

    // Phase 3: re-sync role tuples if the team changed (best-effort).
    if (roleEdit) {
      await this.accessProjection.resyncTaskRoles(taskId);
      await this.messenger.syncTaskChatMembers(taskId);
    }

    // Отмена задачи-шага бизнес-процесса должна остановить процесс (иначе токен ждёт вечно).
    if (patch.status === 'cancelled' && existing.status !== 'cancelled') {
      this.events.emit(
        'task.cancelled',
        { taskId, taskTitle: existing.title, recipientIds: existing.participants.map((p) => p.userId) },
        'tasks',
      );
      try {
        const processes = this.moduleRef.get<{ onTaskCancelled: (taskId: string) => Promise<void> }>(
          DI_TOKENS.ProcessesService,
          { strict: false },
        );
        await processes.onTaskCancelled(taskId);
      } catch (err) {
        this.logger.warn(`settle process on task cancel failed (${taskId}): ${(err as Error)?.message}`);
      }
    }

    return this.getTask(userId, taskId);
  }

  private async applyRoleEdits(
    tx: Prisma.TransactionClient,
    taskId: string,
    existing: { creatorId: string; coinReward?: number; participants: { id: string; userId: string; role: string }[] },
    data: UpdateTaskRequest,
  ) {
    // Per-person reward is locked at the task's coinReward; new workers are funded at it.
    const perPerson = existing.coinReward ?? 0;

    if (data.removeParticipantUserIds?.length) {
      for (const uid of data.removeParticipantUserIds) {
        await this.escrow.release(tx, { refType: 'task', refId: taskId, beneficiaryUserId: uid }); // refund their hold
      }
      await tx.taskParticipant.deleteMany({
        where: { taskId, userId: { in: data.removeParticipantUserIds } },
      });
    }

    if (data.executorId !== undefined) {
      // Replace the single executor (individual tasks): refund the old one, freeze for the new.
      const oldExec = existing.participants.find((p) => p.role === 'executor');
      if (oldExec) await this.escrow.release(tx, { refType: 'task', refId: taskId, beneficiaryUserId: oldExec.userId });
      await tx.taskParticipant.deleteMany({ where: { taskId, role: 'executor' } });
      if (data.executorId) {
        await this.assertInEnvironment(existing.creatorId, [data.executorId]);
        await tx.taskParticipant.upsert({
          where: { taskId_userId: { taskId, userId: data.executorId } },
          update: { role: 'executor' },
          create: { taskId, userId: data.executorId, role: 'executor', rewardCoins: perPerson },
        });
        await this.freezeReward(tx, taskId, existing.creatorId, [data.executorId], perPerson);
      }
    }

    const addWith = async (ids: string[] | undefined, role: TaskRole) => {
      if (!ids?.length) return;
      await this.assertInEnvironment(existing.creatorId, ids);
      for (const uid of ids) {
        await tx.taskParticipant.upsert({
          where: { taskId_userId: { taskId, userId: uid } },
          update: { role },
          create: { taskId, userId: uid, role, rewardCoins: role === 'observer' ? 0 : perPerson },
        });
      }
      if (role !== 'observer') {
        await this.freezeReward(tx, taskId, existing.creatorId, ids, perPerson);
      }
    };
    await addWith(data.addCoExecutorIds, 'co_executor');
    await addWith(data.addObserverIds, 'observer');
  }

  async deleteTask(userId: string, taskId: string) {
    const task = await this.db.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId) {
      throw new ForbiddenException('Удалить задачу может только Постановщик');
    }
    await this.db.$transaction(async (tx) => {
      await this.escrow.releaseAll(tx, { refType: 'task', refId: taskId }); // refund any frozen / paid reward to the creator
      await tx.task.delete({ where: { id: taskId } });
    });
    // Вложения задачи (полиморфный FileLink не каскадится со строкой задачи) —
    // отвязать и прибрать сироты, иначе файлы вечно висят в квоте загрузившего.
    await this.files.unlinkAllForRef('task', taskId).catch(() => undefined);
    await this.accessProjection.taskDeleted(taskId);
    await this.messenger.deleteTaskChat(taskId);
    this.events.emit('task.deleted', { taskId }, 'tasks');
  }

  // ============================================================
  // Acceptance flow (submit → accept / return)
  // ============================================================

  /** Executor/co-executor marks their part done. Self-task → completes immediately. */
  async submitWork(userId: string, taskId: string): Promise<TaskDto> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: true, creator: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');

    // Self-task (no participants): only the creator can complete it, no review step.
    if (task.participants.length === 0) {
      if (task.creatorId !== userId) throw new ForbiddenException('Нет доступа к этой задаче');
      await this.db.task.update({
        where: { id: taskId },
        data: { status: 'done', completedAt: new Date() },
      });
      await this.chatter.log(null, {
        refType: 'task',
        refId: taskId,
        workspaceId: task.workspaceId,
        actorId: userId,
        actorName: fullName(task.creator),
        typeKey: 'task.completed',
        payload: { taskTitle: task.title },
      });
      await this.notifications.emitEvent('task.completed', { taskId, taskTitle: task.title, recipientIds: [userId] }, 'tasks');
      await this.settleLinkedOrder(taskId);
      await this.settleLinkedProcess(taskId);
      try {
        await this.maybeSpawnRecurrence(task);
      } catch (err) {
        this.logger.warn(`spawn recurrence failed (${taskId}): ${(err as Error)?.message}`);
      }
      return this.getTask(userId, taskId);
    }

    const me = task.participants.find((p) => p.userId === userId && p.role !== 'observer');
    if (!me) throw new ForbiddenException('Сдать задачу может только Исполнитель');

    if (me.userId === task.creatorId) {
      // Creator is their own executor → no acceptance needed.
      await this.db.taskParticipant.update({
        where: { id: me.id },
        data: { status: 'accepted', submittedAt: new Date(), acceptedAt: new Date() },
      });
    } else {
      await this.db.taskParticipant.update({
        where: { id: me.id },
        data: { status: 'submitted', submittedAt: new Date(), returnedAt: null },
      });
      const byName = fullName(await this.userMini(userId));
      await this.chatter.log(null, {
        refType: 'task',
        refId: taskId,
        workspaceId: task.workspaceId,
        actorId: userId,
        actorName: byName,
        typeKey: 'task.submitted',
        payload: { taskTitle: task.title },
      });
      await this.notifications.emitEvent(
        'task.submitted',
        { taskId, taskTitle: task.title, byUserId: userId, byName, recipientIds: [task.creatorId] },
        'tasks',
      );
    }

    await this.recomputeStatus(taskId);
    return this.getTask(userId, taskId);
  }

  /** Постановщик accepts a participant's submitted work. */
  async acceptWork(userId: string, taskId: string, participantUserId?: string): Promise<TaskDto> {
    const { task, target } = await this.loadForReview(userId, taskId, participantUserId);
    const [actorName, targetName] = await Promise.all([
      this.userMini(userId).then(fullName),
      this.userMini(target.userId).then(fullName),
    ]);
    let captured: { currencyName: string; amount: number } | null = null;
    await this.db.$transaction(async (tx) => {
      // Status-guarded claim: a concurrent double «Принять» loses here instead of double-capturing
      // (the ledger re-checks resolution after its row lock too — defense in depth).
      const claimed = await tx.taskParticipant.updateMany({
        where: { id: target.id, status: { not: 'accepted' } },
        data: { status: 'accepted', acceptedAt: new Date(), returnedAt: null },
      });
      if (claimed.count === 0) throw new BadRequestException('Работа уже принята');
      const legs = await this.escrow.capture(tx, { refType: 'task', refId: taskId, beneficiaryUserId: target.userId }); // pay out the frozen reward
      captured = legs[0] ?? null;
      await this.chatter.log(tx, {
        refType: 'task',
        refId: taskId,
        workspaceId: task.workspaceId,
        actorId: userId,
        actorName,
        typeKey: 'task.accepted',
        payload: { taskTitle: task.title, targetUserId: target.userId, targetName },
      });
    });
    await this.notifications.emitEvent(
      'task.accepted',
      { taskId, taskTitle: task.title, recipientIds: [target.userId] },
      'tasks',
    );
    if (captured) {
      await this.notifications.emitEvent(
        'wallet.coins.received',
        {
          recipientIds: [target.userId],
          amount: (captured as { amount: number }).amount,
          currencyName: (captured as { currencyName: string }).currencyName,
          taskId,
          taskTitle: task.title,
        },
        'tasks',
      );
    }
    await this.recomputeStatus(taskId);
    return this.getTask(userId, taskId);
  }

  /** Постановщик returns a participant's work for rework. */
  async returnWork(userId: string, taskId: string, participantUserId?: string): Promise<TaskDto> {
    const { task, target } = await this.loadForReview(userId, taskId, participantUserId);
    const [actorName, targetName] = await Promise.all([
      this.userMini(userId).then(fullName),
      this.userMini(target.userId).then(fullName),
    ]);
    await this.db.$transaction(async (tx) => {
      await tx.taskParticipant.update({
        where: { id: target.id },
        data: { status: 'returned', returnedAt: new Date(), submittedAt: null },
      });
      await this.escrow.returnToHold(tx, { refType: 'task', refId: taskId, beneficiaryUserId: target.userId }); // reverse payout + re-freeze if already paid
      await this.chatter.log(tx, {
        refType: 'task',
        refId: taskId,
        workspaceId: task.workspaceId,
        actorId: userId,
        actorName,
        typeKey: 'task.returned',
        payload: { taskTitle: task.title, targetUserId: target.userId, targetName },
      });
    });
    await this.notifications.emitEvent(
      'task.returned',
      { taskId, taskTitle: task.title, recipientIds: [target.userId] },
      'tasks',
    );
    await this.recomputeStatus(taskId);
    return this.getTask(userId, taskId);
  }

  private async loadForReview(userId: string, taskId: string, participantUserId?: string) {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: true },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId) {
      throw new ForbiddenException('Принимать работу может только Постановщик');
    }
    const workers = task.participants.filter((p) => p.role !== 'observer');
    const target = participantUserId
      ? workers.find((p) => p.userId === participantUserId)
      : workers.find((p) => p.role === 'executor') ?? workers[0];
    if (!target) throw new NotFoundException('Участник не найден');
    return { task, target };
  }

  /** Recompute the aggregate Task.status from its participants' states. */
  private async recomputeStatus(taskId: string) {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: { where: { role: { not: 'observer' } } } },
    });
    if (!task) return;
    const workers = task.participants;
    if (workers.length === 0) return;

    const wasDone = task.status === 'done';
    let status: string = task.status;

    if (workers.every((w) => w.status === 'accepted')) {
      status = 'done';
    } else if (workers.every((w) => w.status === 'submitted' || w.status === 'accepted')) {
      status = 'on_review';
    } else if (workers.some((w) => w.status !== 'pending')) {
      status = 'in_progress';
    } else if (task.status === 'on_review') {
      status = 'in_progress';
    }

    const becameDone = status === 'done' && !wasDone;
    if (status !== task.status || becameDone) {
      // Optimistic claim: два конкурентных финальных «Принять» не должны дать дубль
      // task.completed / повторный settlement (статус под нами уже сменили → выходим).
      const claimed = await this.db.task.updateMany({
        where: { id: taskId, status: task.status },
        data: { status, completedAt: status === 'done' ? new Date() : null },
      });
      if (claimed.count === 0) return;
    }

    if (becameDone) {
      const full = await this.db.task.findUnique({
        where: { id: taskId },
        include: { participants: { select: { userId: true } } },
      });
      const recipients = full
        ? [full.creatorId, ...full.participants.map((p) => p.userId)]
        : [task.creatorId];
      // Хроника: завершение — производное состояние (последняя приёмка) → актор = система.
      await this.chatter.log(null, {
        refType: 'task',
        refId: taskId,
        workspaceId: task.workspaceId,
        typeKey: 'task.completed',
        payload: { taskTitle: task.title },
      });
      await this.notifications.emitEvent(
        'task.completed',
        { taskId, taskTitle: task.title, recipientIds: [...new Set(recipients)] },
        'tasks',
      );
      await this.settleLinkedOrder(taskId);
      await this.settleLinkedProcess(taskId);
      if (full) {
        try {
          await this.maybeSpawnRecurrence(full);
        } catch (err) {
          this.logger.warn(`spawn recurrence failed (${taskId}): ${(err as Error)?.message}`);
        }
      }
    }
  }

  /**
   * Settle a linked shop order SYNCHRONOUSLY when its fulfilment task completes — money must not
   * depend on the at-most-once EventBus (a lost task.completed = buyer's funds frozen forever).
   * The ShopEventsListener and the ShopCron sweep stay as idempotent safety nets. Lazy string
   * token because a direct import would close the module cycle ShopModule→TasksModule.
   */
  private async settleLinkedOrder(taskId: string): Promise<void> {
    try {
      const shop = this.moduleRef.get<{ onFulfillmentDone: (taskId: string) => Promise<void> }>(
        DI_TOKENS.ShopService,
        { strict: false },
      );
      await shop.onFulfillmentDone(taskId);
    } catch {
      // Shop unavailable / transient failure — the bus listener or the ShopCron sweep settles it.
    }
  }

  /**
   * Если задача — шаг бизнес-процесса, СИНХРОННО продвигаем токен (тот же
   * ModuleRef-паттерн, что settleLinkedOrder; шина — идемпотентная подстраховка).
   */
  private async settleLinkedProcess(taskId: string): Promise<void> {
    try {
      const processes = this.moduleRef.get<{ onTaskCompleted: (taskId: string) => Promise<void> }>(
        DI_TOKENS.ProcessesService,
        { strict: false },
      );
      await processes.onTaskCompleted(taskId);
    } catch (err) {
      // Transient failure — the bus listener or the ProcessesCron task-sweep re-drives it.
      this.logger.warn(`settle process on task complete failed (${taskId}): ${(err as Error)?.message}`);
    }
  }

  /**
   * Переназначить исполнителя задачи-шага процесса (Ф2.5). Доверенный вызов из движка
   * (права проверены гейтом manager+). Снимает старого исполнителя, ставит нового;
   * награда перемораживается (у процессных задач обычно 0). Членство уже проверено.
   */
  async reassignExecutorTrusted(taskId: string, newExecutorId: string): Promise<void> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: { select: { id: true, userId: true, role: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new BadRequestException('Задача уже завершена');
    }
    const oldExecPre = task.participants.find((p) => p.role === 'executor');
    const oldExecName =
      oldExecPre && oldExecPre.userId !== newExecutorId
        ? fullName(await this.userMini(oldExecPre.userId))
        : null;
    await this.db.$transaction(async (tx) => {
      const oldExec = task.participants.find((p) => p.role === 'executor');
      if (oldExec) {
        if (oldExec.userId === newExecutorId) return; // нечего менять
        await this.escrow.release(tx, { refType: 'task', refId: taskId, beneficiaryUserId: oldExec.userId });
        await tx.taskParticipant.deleteMany({ where: { taskId, role: 'executor' } });
      }
      await tx.taskParticipant.upsert({
        where: { taskId_userId: { taskId, userId: newExecutorId } },
        update: { role: 'executor', status: 'pending', submittedAt: null, acceptedAt: null, returnedAt: null },
        create: { taskId, userId: newExecutorId, role: 'executor', rewardCoins: task.coinReward },
      });
      if (task.coinReward > 0) {
        await this.freezeReward(tx, taskId, task.creatorId, [newExecutorId], task.coinReward);
      }
      // Хроника: переназначение движком процессов — актор = система (плашка «Кто-то
      // назначил(а) задачу» = сегодняшний byName:''). Снятие старого — без плашки.
      await this.chatter.logMany(tx, [
        ...(oldExec && oldExecName
          ? [
              {
                refType: 'task',
                refId: taskId,
                workspaceId: task.workspaceId,
                typeKey: 'task.participant_removed',
                payload: { taskTitle: task.title, targetUserId: oldExec.userId, targetName: oldExecName },
                chatPost: false,
              } satisfies ChatterLogInput,
            ]
          : []),
        {
          refType: 'task',
          refId: taskId,
          workspaceId: task.workspaceId,
          typeKey: 'task.assigned',
          payload: { taskTitle: task.title },
        },
      ]);
    });
    await this.accessProjection.resyncTaskRoles(taskId);
    await this.messenger.syncTaskChatMembers(taskId);
    await this.notifications.emitEvent(
      'task.assigned',
      { taskId, taskTitle: task.title, byUserId: task.creatorId, byName: '', recipientIds: [newExecutorId] },
      'tasks',
    );
  }

  /** On completion of a recurring task, clone the next occurrence (TickTick-style). */
  private async maybeSpawnRecurrence(task: { id: string; recurrenceRule: string | null; dueDate: Date | null; recurrenceParentId: string | null; title: string; description: string | null; priority: string; coinReward: number; coinPenalty: number; creatorId: string; assignedCircleId: string | null; allDay: boolean; reminderAt: Date | null; workspaceId: string | null }) {
    if (!task.recurrenceRule || !task.dueDate) return;
    const next = this.nextOccurrence(task.dueDate, task.recurrenceRule);
    if (!next) return;

    const participants = await this.db.taskParticipant.findMany({
      where: { taskId: task.id },
      select: { userId: true, role: true },
    });

    // Shift the reminder by the same delta as the due date.
    const reminder =
      task.reminderAt && task.dueDate
        ? new Date(task.reminderAt.getTime() + (next.getTime() - task.dueDate.getTime()))
        : null;

    const workerIds = participants
      .filter((p) => p.role !== 'observer')
      .map((p) => p.userId)
      .filter((id) => id !== task.creatorId);

    // Fund the next occurrence only if the creator can still cover it; otherwise spawn it
    // without a reward (a recurring task must not break on insufficient funds).
    let nextReward = task.coinReward;
    if (nextReward > 0 && workerIds.length > 0 && !(await this.canFund(task.creatorId, nextReward * workerIds.length, task.workspaceId))) {
      nextReward = 0;
    }

    await this.db.$transaction(async (tx) => {
      const spawned = await tx.task.create({
        data: {
          title: task.title,
          description: task.description,
          priority: task.priority,
          priorityRank: PRIORITY_RANK[task.priority] ?? 2,
          dueDate: next,
          allDay: task.allDay,
          reminderAt: reminder,
          recurrenceRule: task.recurrenceRule,
          recurrenceParentId: task.recurrenceParentId ?? task.id,
          creatorId: task.creatorId,
          assignedCircleId: task.assignedCircleId,
          coinReward: nextReward,
          coinPenalty: task.coinPenalty,
          workspaceId: task.workspaceId,
          participants: participants.length
            ? { create: participants.map((p) => ({ userId: p.userId, role: p.role, rewardCoins: p.role === 'observer' ? 0 : nextReward })) }
            : undefined,
        },
      });
      if (nextReward > 0) {
        await this.freezeReward(tx, spawned.id, task.creatorId, workerIds, nextReward);
      }
    });
  }

  /**
   * Freeze the per-worker reward of the creator's own currency under the task's escrow agreement.
   * The "no currency ⇒ can't reward" gate lives here (the escrow engine is currency-agnostic).
   * Skips the creator themselves and a zero reward; throws if the creator has no active currency.
   */
  private async freezeReward(
    tx: Prisma.TransactionClient,
    taskId: string,
    creatorId: string,
    workerIds: string[],
    amountEach: number,
  ): Promise<void> {
    if (amountEach <= 0) return;
    const workers = [...new Set(workerIds)].filter((id) => id && id !== creatorId);
    if (workers.length === 0) return;
    // A task created in a company context (workspaceId set) pays the COMPANY currency from the
    // company TREASURY (payer = workspace); a personal task pays the creator's own currency.
    const task = await tx.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } });
    const workspaceId = task?.workspaceId ?? null;
    const currency = workspaceId
      ? await tx.currency.findFirst({ where: { issuerType: 'workspace', issuerId: workspaceId, status: 'active' } })
      : await tx.currency.findFirst({ where: { issuerType: 'user', issuerId: creatorId, status: 'active' } });
    if (!currency) {
      throw new BadRequestException(
        workspaceId ? 'Создайте валюту компании, чтобы назначать награду' : 'Создайте свою валюту, чтобы назначать награду за задачу',
      );
    }
    for (const workerId of workers) {
      await this.escrow.fund(tx, {
        refType: 'task',
        refId: taskId,
        payerUserId: workspaceId ?? creatorId,
        payerType: workspaceId ? 'workspace' : 'user',
        beneficiaryUserId: workerId,
        currencyId: currency.id,
        amount: amountEach,
      });
    }
  }

  /** Can the creator still cover `total` coins of their own currency (available balance)? */
  private async canFund(creatorId: string, total: number, workspaceId?: string | null): Promise<boolean> {
    const currency = workspaceId
      ? await this.db.currency.findFirst({ where: { issuerType: 'workspace', issuerId: workspaceId, status: 'active' } })
      : await this.db.currency.findFirst({ where: { issuerType: 'user', issuerId: creatorId, status: 'active' } });
    if (!currency) return false;
    const acct = await this.db.account.findUnique({
      where: {
        currencyId_type_ownerType_ownerId: {
          currencyId: currency.id,
          type: 'user',
          ownerType: workspaceId ? 'workspace' : 'user',
          ownerId: workspaceId ?? creatorId,
        },
      },
    });
    const available = acct ? acct.balance - acct.held : 0n;
    return available >= BigInt(total);
  }

  private nextOccurrence(from: Date, rule: string): Date | null {
    const d = new Date(from);
    if (rule.startsWith('FREQ=DAILY')) d.setDate(d.getDate() + 1);
    else if (rule.startsWith('FREQ=WEEKLY')) d.setDate(d.getDate() + 7);
    else if (rule.startsWith('FREQ=MONTHLY')) d.setMonth(d.getMonth() + 1);
    else if (rule.startsWith('FREQ=YEARLY')) d.setFullYear(d.getFullYear() + 1);
    else return null;
    return d;
  }

  // ============================================================
  // Cron-driven dispatch (reminders & overdue) — called by TasksCron
  // ============================================================

  /** Send "due soon" reminders for tasks whose reminderAt has arrived. Idempotent via reminderSentAt. */
  async dispatchDueReminders(): Promise<number> {
    const now = new Date();
    const due = await this.db.task.findMany({
      where: {
        reminderAt: { lte: now },
        reminderSentAt: null,
        status: { notIn: ['done', 'cancelled'] },
      },
      include: { participants: { select: { userId: true, role: true } } },
      take: 500,
    });
    for (const t of due) {
      await this.notifications.emitEvent(
        'task.due_soon',
        { taskId: t.id, taskTitle: t.title, recipientIds: this.taskAudience(t) },
        'tasks',
      );
      await this.db.task.update({ where: { id: t.id }, data: { reminderSentAt: now } });
    }
    return due.length;
  }

  /** Notify about tasks that crossed their deadline in the last 24h (daily cadence → once each). */
  async dispatchOverdue(): Promise<number> {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const overdue = await this.db.task.findMany({
      where: {
        dueDate: { gte: since, lt: now },
        status: { notIn: ['done', 'cancelled'] },
      },
      include: { participants: { select: { userId: true, role: true } } },
      take: 500,
    });
    for (const t of overdue) {
      await this.notifications.emitEvent(
        'task.overdue',
        { taskId: t.id, taskTitle: t.title, recipientIds: this.taskAudience(t) },
        'tasks',
      );
    }
    return overdue.length;
  }

  /** Creator + active workers (executors/co-executors), de-duplicated. */
  private taskAudience(t: { creatorId: string; participants: { userId: string; role: string }[] }): string[] {
    return [
      ...new Set([
        t.creatorId,
        ...t.participants.filter((p) => p.role !== 'observer').map((p) => p.userId),
      ]),
    ];
  }

  // ============================================================
  // Internal mapping
  // ============================================================

  private async assertCanView(
    userId: string,
    taskId: string,
    task: { creatorId: string; participants: { userId: string }[] },
  ) {
    // Engine-first (task roles projected into core/access); fall back to the loaded data so
    // tasks created before projection never lose access during the transition.
    if (await this.access.can(this.user(userId), 'task.view', taskId)) return;
    if (task.creatorId === userId) return;
    if (task.participants.some((p) => p.userId === userId)) return;
    throw new ForbiddenException('Нет доступа к этой задаче');
  }

  private async userMini(id: string): Promise<UserMini> {
    const u = await this.db.user.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return u ?? { id, firstName: '', lastName: null, avatar: null };
  }

  private viewerRole(
    viewerId: string,
    creatorId: string,
    participants: { userId: string; role?: string }[],
  ): ViewerTaskRole | null {
    if (viewerId === creatorId) return 'creator';
    const p = participants.find((x) => x.userId === viewerId);
    return (p?.role as TaskRole) ?? null;
  }

  private toParticipantDto(p: TaskRow['participants'][number]): TaskParticipantDto {
    return {
      id: p.id,
      userId: p.userId,
      name: fullName(p.user),
      avatar: p.user.avatar,
      role: p.role as TaskRole,
      status: p.status as TaskParticipantDto['status'],
      submittedAt: p.submittedAt?.toISOString() ?? null,
      acceptedAt: p.acceptedAt?.toISOString() ?? null,
      returnedAt: p.returnedAt?.toISOString() ?? null,
      rewardCoins: p.rewardCoins,
      giftRewardId: p.giftRewardId,
    };
  }

  private toDto(task: TaskRow, viewerId: string): TaskDto {
    const participants = task.participants.map((p) => this.toParticipantDto(p));
    const executor = participants.find((p) => p.role === 'executor') ?? null;
    const coExecutors = participants.filter((p) => p.role === 'co_executor');
    const observers = participants.filter((p) => p.role === 'observer');

    const workers = participants.filter((p) => p.role !== 'observer');
    const progress = task.assignedCircleId
      ? { accepted: workers.filter((w) => w.status === 'accepted').length, total: workers.length }
      : null;

    const myRole = this.viewerRole(viewerId, task.creatorId, task.participants);
    const myParticipant = task.participants.find((p) => p.userId === viewerId);

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status as TaskDto['status'],
      priority: task.priority as TaskDto['priority'],
      inbox: task.inbox,
      dueDate: task.dueDate?.toISOString() ?? null,
      startDate: task.startDate?.toISOString() ?? null,
      allDay: task.allDay,
      reminderAt: task.reminderAt?.toISOString() ?? null,
      recurrenceRule: task.recurrenceRule,
      creatorId: task.creatorId,
      creatorName: fullName(task.creator),
      creatorAvatar: task.creator.avatar,
      executor,
      coExecutors,
      observers,
      assignedCircleId: task.assignedCircleId,
      assignedCircleName: task.assignedCircle?.name ?? null,
      progress,
      parentId: task.parentId,
      subtasksCount: task._count.subtasks,
      subtasksDoneCount: 0,
      coinReward: task.coinReward,
      coinPenalty: task.coinPenalty,
      giftRewardId: task.giftRewardId,
      workspaceId: task.workspaceId,
      calendarEventId: null,
      tags: task.tags.map((t) => t.name),
      myRole,
      myParticipantStatus: (myParticipant?.status as TaskParticipantDto['status']) ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
    };
  }
}
