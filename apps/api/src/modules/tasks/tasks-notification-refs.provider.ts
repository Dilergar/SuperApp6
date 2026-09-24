import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Задача как объект уведомления: видят постановщик и участники; строка раскрывается в рич-карту `task`. */
@Injectable()
export class TasksNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('task', {
      canViewMany: async (userIds, taskId) => {
        const task = await this.db.task.findUnique({
          where: { id: taskId, deletedAt: null },
          select: { creatorId: true, participants: { select: { userId: true } } },
        });
        if (!task) return [];
        return intersect(userIds, [task.creatorId, ...task.participants.map((p) => p.userId)]);
      },
      href: (ref) => `/tasks/${ref.id}`,
      richCardType: 'task',
    });
  }
}
