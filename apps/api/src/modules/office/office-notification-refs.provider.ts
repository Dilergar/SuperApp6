import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Встреча офиса: видят участники; рич-карта `office_room` («Идёт сейчас · N», присоединиться). */
@Injectable()
export class OfficeNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('office_room', {
      canViewMany: async (userIds, roomId) => {
        const parts = await this.db.officeRoomParticipant.findMany({ where: { roomId, userId: { in: userIds } }, select: { userId: true } });
        return intersect(userIds, parts.map((p) => p.userId));
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/office/${ref.id}` : null),
      richCardType: 'office_room',
    });
  }
}
