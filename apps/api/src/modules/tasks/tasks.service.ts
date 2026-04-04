import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import type { Prisma } from '@prisma/client';

@Injectable()
export class TasksService {
  constructor(
    private db: DatabaseService,
    private events: EventBusService,
  ) {}

  /** Get tasks with filters and pagination */
  async getTasks(
    userId: string,
    filters: {
      status?: string[];
      priority?: string[];
      assigneeId?: string;
      workspaceId?: string | null;
      parentId?: string | null;
      dueDateFrom?: string;
      dueDateTo?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.TaskWhereInput = {
      OR: [
        { creatorId: userId },
        { assigneeId: userId },
      ],
    };

    // Only top-level tasks by default (not subtasks)
    if (filters.parentId === undefined) {
      where.parentId = null;
    } else if (filters.parentId !== null) {
      where.parentId = filters.parentId;
    }

    if (filters.status?.length) where.status = { in: filters.status };
    if (filters.priority?.length) where.priority = { in: filters.priority };
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;
    if (filters.workspaceId !== undefined) where.workspaceId = filters.workspaceId;

    if (filters.dueDateFrom || filters.dueDateTo) {
      where.dueDate = {};
      if (filters.dueDateFrom) where.dueDate.gte = new Date(filters.dueDateFrom);
      if (filters.dueDateTo) where.dueDate.lte = new Date(filters.dueDateTo);
    }

    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [tasks, total] = await Promise.all([
      this.db.task.findMany({
        where,
        include: {
          creator: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          tags: { select: { name: true } },
          _count: { select: { subtasks: true, comments: true } },
        },
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.db.task.count({ where }),
    ]);

    return {
      data: tasks.map((t) => ({
        ...t,
        tags: t.tags.map((tag) => tag.name),
        subtasksCount: t._count.subtasks,
        commentsCount: t._count.comments,
        _count: undefined,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Create a new task */
  async createTask(userId: string, data: {
    title: string;
    description?: string;
    priority?: string;
    dueDate?: string;
    startDate?: string;
    assigneeId?: string;
    parentId?: string;
    coinReward?: number;
    coinPenalty?: number;
    tags?: string[];
    workspaceId?: string;
    addToCalendar?: boolean;
  }) {
    // Verify parent task exists and belongs to user
    if (data.parentId) {
      const parent = await this.db.task.findUnique({ where: { id: data.parentId } });
      if (!parent || (parent.creatorId !== userId && parent.assigneeId !== userId)) {
        throw new ForbiddenException('Родительская задача не найдена');
      }
    }

    const task = await this.db.task.create({
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority || 'medium',
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        creatorId: userId,
        assigneeId: data.assigneeId,
        parentId: data.parentId,
        coinReward: data.coinReward || 0,
        coinPenalty: data.coinPenalty || 0,
        workspaceId: data.workspaceId,
        tags: data.tags?.length
          ? { create: data.tags.map((name) => ({ name })) }
          : undefined,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        tags: { select: { name: true } },
      },
    });

    // Emit event for other modules (e.g. calendar)
    this.events.emit('task.created', {
      taskId: task.id,
      creatorId: userId,
      assigneeId: data.assigneeId,
      title: task.title,
      dueDate: data.dueDate,
      addToCalendar: data.addToCalendar,
    }, 'tasks');

    return {
      ...task,
      tags: task.tags.map((t) => t.name),
    };
  }

  /** Get single task with subtasks */
  async getTask(userId: string, taskId: string) {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        tags: { select: { name: true } },
        subtasks: {
          include: {
            assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
            _count: { select: { subtasks: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { comments: true } },
      },
    });

    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId && task.assigneeId !== userId) {
      throw new ForbiddenException('Нет доступа к этой задаче');
    }

    return {
      ...task,
      tags: task.tags.map((t) => t.name),
      commentsCount: task._count.comments,
      _count: undefined,
    };
  }

  /** Update task */
  async updateTask(userId: string, taskId: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    dueDate?: string | null;
    startDate?: string | null;
    assigneeId?: string | null;
    coinReward?: number;
    coinPenalty?: number;
    tags?: string[];
  }) {
    const existing = await this.db.task.findUnique({ where: { id: taskId } });
    if (!existing) throw new NotFoundException('Задача не найдена');
    if (existing.creatorId !== userId && existing.assigneeId !== userId) {
      throw new ForbiddenException('Нет доступа к этой задаче');
    }

    const updateData: Prisma.TaskUpdateInput = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.coinReward !== undefined) updateData.coinReward = data.coinReward;
    if (data.coinPenalty !== undefined) updateData.coinPenalty = data.coinPenalty;

    if (data.dueDate !== undefined) {
      updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    }
    if (data.startDate !== undefined) {
      updateData.startDate = data.startDate ? new Date(data.startDate) : null;
    }
    if (data.assigneeId !== undefined) {
      updateData.assignee = data.assigneeId
        ? { connect: { id: data.assigneeId } }
        : { disconnect: true };
    }

    // Handle status change
    if (data.status !== undefined) {
      updateData.status = data.status;
      if (data.status === 'done' && existing.status !== 'done') {
        updateData.completedAt = new Date();
      } else if (data.status !== 'done') {
        updateData.completedAt = null;
      }
    }

    // Handle tags — replace all
    if (data.tags !== undefined) {
      await this.db.taskTag.deleteMany({ where: { taskId } });
      if (data.tags.length > 0) {
        await this.db.taskTag.createMany({
          data: data.tags.map((name) => ({ taskId, name })),
        });
      }
    }

    const task = await this.db.task.update({
      where: { id: taskId },
      data: updateData,
      include: {
        creator: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        tags: { select: { name: true } },
      },
    });

    // Emit events
    if (data.status === 'done' && existing.status !== 'done') {
      this.events.emit('task.completed', {
        taskId: task.id,
        creatorId: task.creatorId,
        assigneeId: task.assigneeId,
        coinReward: task.coinReward,
      }, 'tasks');
    }

    this.events.emit('task.updated', {
      taskId: task.id,
      changes: data,
    }, 'tasks');

    return {
      ...task,
      tags: task.tags.map((t) => t.name),
    };
  }

  /** Delete task */
  async deleteTask(userId: string, taskId: string) {
    const task = await this.db.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId) {
      throw new ForbiddenException('Только создатель может удалить задачу');
    }

    await this.db.task.delete({ where: { id: taskId } });

    this.events.emit('task.deleted', { taskId }, 'tasks');
  }

  /** Add comment to task */
  async addComment(userId: string, taskId: string, content: string) {
    const task = await this.db.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId && task.assigneeId !== userId) {
      throw new ForbiddenException('Нет доступа к этой задаче');
    }

    return this.db.taskComment.create({
      data: {
        taskId,
        authorId: userId,
        content,
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });
  }

  /** Get comments for task */
  async getComments(userId: string, taskId: string, page = 1, limit = 50) {
    const task = await this.db.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Задача не найдена');
    if (task.creatorId !== userId && task.assigneeId !== userId) {
      throw new ForbiddenException('Нет доступа к этой задаче');
    }

    return this.db.taskComment.findMany({
      where: { taskId },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}
