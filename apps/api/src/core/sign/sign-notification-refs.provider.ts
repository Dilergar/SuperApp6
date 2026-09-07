import { Injectable, OnModuleInit } from '@nestjs/common';
import { signRequestHref } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { intersect } from '../notifications/notifications.ref-helpers';

/** Заявка на подпись: видят автор и подписанты. */
@Injectable()
export class SignNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('sign_request', {
      canViewMany: async (userIds, requestId) => {
        const req = await this.db.signRequest.findUnique({
          where: { id: requestId },
          select: { createdById: true, acts: { select: { signerUserId: true } } },
        });
        if (!req) return [];
        return intersect(userIds, [req.createdById, ...req.acts.map((a) => a.signerUserId).filter((id): id is string => !!id)]);
      },
      href: (ref, ctx) => signRequestHref(ref.id, ctx.workspaceId),
    });
  }
}
