import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { Prisma } from '@prisma/client';
import type {
  Task as TaskDto,
  TaskParticipant as TaskParticipantDto,
  TaskRole,
  ViewerTaskRole,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilter,
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
  _count: { select: { subtasks: true, comments: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;
type UserMini = { id: string; firstName: string; lastName: string | null; avatar: string | null };

const fullName = (u: UserMini) => `${u.firstName} ${u.lastName ?? ''}`.trim();

@Injectable()
export class TasksService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
  ) {}

  // ============================================================
  // Helpers: social-graph validation & group expansion
  // ============================================================

  /** Throw unless every id (other than the creator themselves) is a confirmed contact. */
  private async assertInEnvironment(ownerId: string, ids: string[]): Promise<void> {
    const others = [...new Set(ids)].filter((id) => id && id !== ownerId);
    if (others.length === 0) return;

    const links = await this.db.contactLink.findMany({
      where: {
        OR: others.map((id) => {
          const [a, b] = ownerId < id ? [ownerId, id] : [id, ownerId];
          return { userAId: a, userBId: b };
        }),
      },
      select: { userAId: true, userBId: true },
    });

    const linked = new Set(links.map((l) => (l.userAId === ownerId ? l.userBId : l.userAId)));
    const missing = others.filter((id) => !linked.has(id));
    if (missing.length > 0) {
      throw new ForbiddenException('Назначать можно только людей из вашего окружения');
    }
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

  async createTask(userId: string, data: CreateTaskRequest): Promise<TaskDto> {
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
      await this.assertInEnvironment(userId, [data.executorId]);
      setRole(data.executorId, 'executor');
      if (data.coExecutorIds?.length) {
        await this.assertInEnvironment(userId, data.coExecutorIds);
        for (const id of data.coExecutorIds) setRole(id, 'co_executor');
      }
    }
    // else: self-task — no participants, no acceptance step.

    if (data.observerIds?.length) {
      await this.assertInEnvironment(userId, data.observerIds);
      for (const id of data.observerIds) setRole(id, 'observer');
    }

    const participantsCreate = [...roleByUser.entries()].map(([uid, role]) => ({
      userId: uid,
      role,
      rewardCoins: role === 'observer' ? 0 : reward,
    }));

    const task = await this.db.task.create({
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority || 'medium',
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        allDay: data.allDay ?? false,
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

    // Calendar integration (existing contract).
    this.events.emit(
      'task.created',
      { taskId: task.id, creatorId: userId, title: task.title, dueDate: data.dueDate, addToCalendar: data.addToCalendar },
      'tasks',
    );

    // Notify everyone who was put on the task (not the creator).
    const recipientIds = participantsCreate.map((p) => p.userId).filter((id) => id !== userId);
    if (recipientIds.length > 0) {
      this.events.emit(
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

  async getTasks(userId: string, filters: TaskFilter & { parentId?: string | null }) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const and: Prisma.TaskWhereInput[] = [
      { OR: [{ creatorId: userId }, { participants: { some: { userId } } }] },
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
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
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
      case 'today':
        and.push({ status: open, dueDate: { gte: startOfToday, lte: endOfToday } });
        break;
      case 'upcoming':
        and.push({ status: open, dueDate: { gt: endOfToday } });
        break;
      case 'overdue':
        and.push({ status: open, dueDate: { lt: now } });
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

  async getTask(userId: string, taskId: string): Promise<TaskDto> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: {
        ...TASK_INCLUDE,
        subtasks: { select: { status: true } },
      },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    await this.assertCanView(userId, task);

    const dto = this.toDto(task, userId);
    dto.subtasksCount = task.subtasks.length;
    dto.subtasksDoneCount = task.subtasks.filter((s) => s.status === 'done').length;
    return dto;
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

    const patch: Prisma.TaskUpdateInput = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.priority !== undefined) patch.priority = data.priority;
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

    await this.db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: patch });

      if (data.tags !== undefined) {
        await tx.taskTag.deleteMany({ where: { taskId } });
        if (data.tags.length) {
          await tx.taskTag.createMany({ data: data.tags.map((name) => ({ taskId, name })) });
        }
      }

      if (isCreator) {
        await this.applyRoleEdits(tx, taskId, existing, data);
      }
    });

    return this.getTask(userId, taskId);
  }

  private async applyRoleEdits(
    tx: Prisma.TransactionClient,
    taskId: string,
    existing: { creatorId: string; coinReward?: number; participants: { id: string; userId: string; role: string }[] },
    data: UpdateTaskRequest,
  ) {
    const reward = data.coinReward;

    if (data.removeParticipantUserIds?.length) {
      await tx.taskParticipant.deleteMany({
        where: { taskId, userId: { in: data.removeParticipantUserIds } },
      });
    }

    if (data.executorId !== undefined) {
      // Replace the single executor (individual tasks).
      await tx.taskParticipant.deleteMany({ where: { taskId, role: 'executor' } });
      if (data.executorId) {
        await this.assertInEnvironment(existing.creatorId, [data.executorId]);
        await tx.taskParticipant.upsert({
          where: { taskId_userId: { taskId, userId: data.executorId } },
          update: { role: 'executor' },
          create: { taskId, userId: data.executorId, role: 'executor', rewardCoins: reward ?? 0 },
        });
      }
    }

    const addWith = async (ids: string[] | undefined, role: TaskRole) => {
      if (!ids?.length) return;
      await this.assertInEnvironment(existing.creatorId, ids);
      for (const uid of ids) {
        await tx.taskParticipant.upsert({
          where: { taskId_userId: { taskId, userId: uid } },
          update: { role },
          create: { taskId, userId: uid, role, rewardCoins: role === 'observer' ? 0 : reward ?? 0 },
        });
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
    await this.db.task.delete({ where: { id: taskId } });
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
      this.events.emit('task.completed', { taskId, taskTitle: task.title, recipientIds: [userId] }, 'tasks');
      await this.maybeSpawnRecurrence(task);
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
      this.events.emit(
        'task.submitted',
        { taskId, taskTitle: task.title, byUserId: userId, byName: fullName(await this.userMini(userId)), recipientIds: [task.creatorId] },
        'tasks',
      );
    }

    await this.recomputeStatus(taskId);
    return this.getTask(userId, taskId);
  }

  /** Постановщик accepts a participant's submitted work. */
  async acceptWork(userId: string, taskId: string, participantUserId?: string): Promise<TaskDto> {
    const { task, target } = await this.loadForReview(userId, taskId, participantUserId);
    await this.db.taskParticipant.update({
      where: { id: target.id },
      data: { status: 'accepted', acceptedAt: new Date(), returnedAt: null },
    });
    this.events.emit(
      'task.accepted',
      { taskId, taskTitle: task.title, recipientIds: [target.userId] },
      'tasks',
    );
    await this.recomputeStatus(taskId);
    return this.getTask(userId, taskId);
  }

  /** Постановщик returns a participant's work for rework. */
  async returnWork(userId: string, taskId: string, participantUserId?: string): Promise<TaskDto> {
    const { task, target } = await this.loadForReview(userId, taskId, participantUserId);
    await this.db.taskParticipant.update({
      where: { id: target.id },
      data: { status: 'returned', returnedAt: new Date(), submittedAt: null },
    });
    this.events.emit(
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
      await this.db.task.update({
        where: { id: taskId },
        data: { status, completedAt: status === 'done' ? new Date() : null },
      });
    }

    if (becameDone) {
      const full = await this.db.task.findUnique({
        where: { id: taskId },
        include: { participants: { select: { userId: true } } },
      });
      const recipients = full
        ? [full.creatorId, ...full.participants.map((p) => p.userId)]
        : [task.creatorId];
      this.events.emit(
        'task.completed',
        { taskId, taskTitle: task.title, recipientIds: [...new Set(recipients)] },
        'tasks',
      );
      if (full) await this.maybeSpawnRecurrence(full);
    }
  }

  /** On completion of a recurring task, clone the next occurrence (TickTick-style). */
  private async maybeSpawnRecurrence(task: { id: string; recurrenceRule: string | null; dueDate: Date | null; recurrenceParentId: string | null; title: string; description: string | null; priority: string; coinReward: number; coinPenalty: number; creatorId: string; assignedCircleId: string | null; allDay: boolean; reminderAt: Date | null; workspaceId: string | null }) {
    if (!task.recurrenceRule || !task.dueDate) return;
    const next = this.nextOccurrence(task.dueDate, task.recurrenceRule);
    if (!next) return;

    const participants = await this.db.taskParticipant.findMany({
      where: { taskId: task.id },
      select: { userId: true, role: true, rewardCoins: true },
    });

    // Shift the reminder by the same delta as the due date.
    const reminder =
      task.reminderAt && task.dueDate
        ? new Date(task.reminderAt.getTime() + (next.getTime() - task.dueDate.getTime()))
        : null;

    await this.db.task.create({
      data: {
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: next,
        allDay: task.allDay,
        reminderAt: reminder,
        recurrenceRule: task.recurrenceRule,
        recurrenceParentId: task.recurrenceParentId ?? task.id,
        creatorId: task.creatorId,
        assignedCircleId: task.assignedCircleId,
        coinReward: task.coinReward,
        coinPenalty: task.coinPenalty,
        workspaceId: task.workspaceId,
        participants: participants.length
          ? { create: participants.map((p) => ({ userId: p.userId, role: p.role, rewardCoins: p.rewardCoins })) }
          : undefined,
      },
    });
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
      this.events.emit(
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
      this.events.emit(
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
  // Chat (per-task comments — open to all roles)
  // ============================================================

  async addComment(userId: string, taskId: string, content: string) {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: { select: { userId: true, role: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    await this.assertCanView(userId, task);

    const comment = await this.db.taskComment.create({
      data: { taskId, authorId: userId, content },
      include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });

    const recipients = [task.creatorId, ...task.participants.map((p) => p.userId)].filter(
      (id) => id !== userId,
    );
    if (recipients.length) {
      this.events.emit(
        'task.commented',
        { taskId, taskTitle: task.title, byUserId: userId, byName: fullName(comment.author), recipientIds: [...new Set(recipients)] },
        'tasks',
      );
    }

    return {
      id: comment.id,
      taskId,
      authorId: userId,
      authorName: fullName(comment.author),
      authorAvatar: comment.author.avatar,
      authorRole: this.viewerRole(userId, task.creatorId, task.participants as { userId: string; role?: string }[]),
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    };
  }

  async getComments(userId: string, taskId: string, page = 1, limit = 50) {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: { participants: { select: { userId: true, role: true } } },
    });
    if (!task) throw new NotFoundException('Задача не найдена');
    await this.assertCanView(userId, task);

    const comments = await this.db.taskComment.findMany({
      where: { taskId },
      include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return comments.map((c) => ({
      id: c.id,
      taskId,
      authorId: c.authorId,
      authorName: fullName(c.author),
      authorAvatar: c.author.avatar,
      authorRole: this.viewerRole(c.authorId, task.creatorId, task.participants),
      content: c.content,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  // ============================================================
  // Internal mapping
  // ============================================================

  private async assertCanView(userId: string, task: { creatorId: string; participants: { userId: string }[] }) {
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
      commentsCount: task._count.comments,
      myRole,
      myParticipantStatus: (myParticipant?.status as TaskParticipantDto['status']) ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
    };
  }
}
