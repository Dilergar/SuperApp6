import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Организация (владелец) и приглашение в неё (приглашённый + пригласивший). */
@Injectable()
export class WorkspacesNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('workspace', {
      canViewMany: async (userIds, workspaceId) => {
        const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
        return ws ? intersect(userIds, [ws.ownerId]) : [];
      },
      href: () => '/dashboard',
    });
    this.refs.register('workspace_invitation', {
      canViewMany: async (userIds, invitationId) => {
        const inv = await this.db.workspaceInvitation.findUnique({ where: { id: invitationId }, select: { toUserId: true, invitedBy: true } });
        return inv ? intersect(userIds, [inv.toUserId, inv.invitedBy].filter((id): id is string => !!id)) : [];
      },
      href: () => '/dashboard',
    });
  }
}
