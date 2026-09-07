import { Injectable, OnModuleInit } from '@nestjs/common';
import { approvalHref } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { intersect } from '../notifications/notifications.ref-helpers';

/** Заявка «Ждут решения»: видят автор и адресаты шагов; рич-карта `approval_request` — решение прямо из строки. */
@Injectable()
export class ApprovalsNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('approval_request', {
      canViewMany: async (userIds, requestId) => {
        const req = await this.db.approvalRequest.findUnique({
          where: { id: requestId },
          select: { createdById: true, steps: { select: { awaitingUserIds: true } } },
        });
        if (!req) return [];
        return intersect(userIds, [req.createdById, ...req.steps.flatMap((s) => s.awaitingUserIds)]);
      },
      href: (ref, ctx) => approvalHref(ref.id, ctx.workspaceId),
      richCardType: 'approval_request',
    });
  }
}
