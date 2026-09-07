import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Событие календаря: видят организатор и участники; рич-карта `event`. */
@Injectable()
export class CalendarNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('event', {
      canViewMany: async (userIds, eventId) => {
        const ev = await this.db.calendarEvent.findUnique({
          where: { id: eventId },
          select: { userId: true, participants: { select: { userId: true } } },
        });
        if (!ev) return [];
        return intersect(userIds, [ev.userId, ...ev.participants.map((p) => p.userId)]);
      },
      href: (ref) => `/calendar?event=${ref.id}`,
      richCardType: 'event',
    });
  }
}
