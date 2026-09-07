import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Приглашение в окружение: видят отправитель и получатель. */
@Injectable()
export class ContactsNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('contact_invitation', {
      canViewMany: async (userIds, invitationId) => {
        const inv = await this.db.contactInvitation.findUnique({ where: { id: invitationId }, select: { fromUserId: true, toUserId: true } });
        return inv ? intersect(userIds, [inv.fromUserId, inv.toUserId].filter((id): id is string => !!id)) : [];
      },
      href: () => '/circles',
    });
  }
}
