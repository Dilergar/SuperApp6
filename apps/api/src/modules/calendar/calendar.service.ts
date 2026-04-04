import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';

@Injectable()
export class CalendarService {
  constructor(private db: DatabaseService) {}

  /** Get events for a date range */
  async getEvents(
    userId: string,
    from: string,
    to: string,
    options?: { types?: string[]; includeShared?: boolean },
  ) {
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // Get own events
    const where: Record<string, unknown> = {
      userId,
      startTime: { lte: toDate },
      endTime: { gte: fromDate },
    };

    if (options?.types?.length) {
      where['type'] = { in: options.types };
    }

    const ownEvents = await this.db.calendarEvent.findMany({
      where: where as any,
      orderBy: { startTime: 'asc' },
    });

    // Get shared calendars events
    let sharedEvents: typeof ownEvents = [];
    if (options?.includeShared !== false) {
      const shares = await this.db.calendarShare.findMany({
        where: { sharedWithUserId: userId },
        select: { calendarOwnerId: true },
      });

      if (shares.length > 0) {
        sharedEvents = await this.db.calendarEvent.findMany({
          where: {
            userId: { in: shares.map((s) => s.calendarOwnerId) },
            startTime: { lte: toDate },
            endTime: { gte: fromDate },
          },
          orderBy: { startTime: 'asc' },
        });
      }
    }

    return [...ownEvents, ...sharedEvents].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
  }

  /** Create calendar event */
  async createEvent(userId: string, data: {
    title: string;
    description?: string;
    startTime: string;
    endTime: string;
    allDay?: boolean;
    color?: string;
    type?: string;
    recurrenceRule?: string;
    taskId?: string;
  }) {
    return this.db.calendarEvent.create({
      data: {
        title: data.title,
        description: data.description,
        startTime: new Date(data.startTime),
        endTime: new Date(data.endTime),
        allDay: data.allDay || false,
        color: data.color,
        type: data.type || 'event',
        recurrenceRule: data.recurrenceRule,
        userId,
        taskId: data.taskId,
      },
    });
  }

  /** Update calendar event */
  async updateEvent(userId: string, eventId: string, data: {
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    allDay?: boolean;
    color?: string;
    recurrenceRule?: string | null;
  }) {
    const event = await this.db.calendarEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Событие не найдено');

    // Check access: owner or shared with edit permission
    if (event.userId !== userId) {
      const share = await this.db.calendarShare.findUnique({
        where: {
          calendarOwnerId_sharedWithUserId: {
            calendarOwnerId: event.userId,
            sharedWithUserId: userId,
          },
        },
      });
      if (!share || share.permission !== 'edit') {
        throw new ForbiddenException('Нет доступа к этому событию');
      }
    }

    return this.db.calendarEvent.update({
      where: { id: eventId },
      data: {
        title: data.title,
        description: data.description,
        startTime: data.startTime ? new Date(data.startTime) : undefined,
        endTime: data.endTime ? new Date(data.endTime) : undefined,
        allDay: data.allDay,
        color: data.color,
        recurrenceRule: data.recurrenceRule,
      },
    });
  }

  /** Delete calendar event */
  async deleteEvent(userId: string, eventId: string) {
    const event = await this.db.calendarEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Событие не найдено');
    if (event.userId !== userId) {
      throw new ForbiddenException('Только владелец может удалить событие');
    }

    await this.db.calendarEvent.delete({ where: { id: eventId } });
  }

  /** Share calendar with another user */
  async shareCalendar(userId: string, sharedWithUserId: string, permission: 'view' | 'edit') {
    return this.db.calendarShare.upsert({
      where: {
        calendarOwnerId_sharedWithUserId: {
          calendarOwnerId: userId,
          sharedWithUserId,
        },
      },
      create: {
        calendarOwnerId: userId,
        sharedWithUserId,
        permission,
      },
      update: { permission },
    });
  }

  /** Remove calendar share */
  async unshareCalendar(userId: string, sharedWithUserId: string) {
    await this.db.calendarShare.delete({
      where: {
        calendarOwnerId_sharedWithUserId: {
          calendarOwnerId: userId,
          sharedWithUserId,
        },
      },
    });
  }

  /** Get list of people who have access to my calendar */
  async getShares(userId: string) {
    return this.db.calendarShare.findMany({
      where: { calendarOwnerId: userId },
      include: {
        sharedWith: {
          select: { id: true, firstName: true, lastName: true, avatar: true },
        },
      },
    });
  }

  /** Create calendar event from task (called by event listener) */
  async createEventFromTask(taskData: {
    taskId: string;
    userId: string;
    title: string;
    dueDate: string;
  }) {
    const dueDate = new Date(taskData.dueDate);
    const endDate = new Date(dueDate);
    endDate.setHours(endDate.getHours() + 1);

    return this.db.calendarEvent.create({
      data: {
        title: taskData.title,
        startTime: dueDate,
        endTime: endDate,
        type: 'task',
        color: '#FF6B6B',
        userId: taskData.userId,
        taskId: taskData.taskId,
      },
    });
  }
}
