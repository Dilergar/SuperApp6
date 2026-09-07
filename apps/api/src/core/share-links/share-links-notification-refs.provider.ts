import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { intersect } from '../notifications/notifications.ref-helpers';

/** Гостевая ссылка: «открыли» видит тот, кто её выдал; схлопывание по ссылке. */
@Injectable()
export class ShareLinksNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('share_link', {
      canViewMany: async (userIds, id) => {
        const link = await this.db.shareLink.findUnique({ where: { id }, select: { createdById: true } });
        return link ? intersect(userIds, [link.createdById]) : [];
      },
      href: () => '/profile/links',
    });
  }
}
