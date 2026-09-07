import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { workspaceMembersOf } from '../../core/notifications/notifications.ref-helpers';

/** КЭДО: кадровое действие, трудовой договор, сдача в ЕСУТД — видят члены организации (адресаты и так гейтились рангом). */
@Injectable()
export class HrNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('hr_action', {
      canViewMany: async (userIds, id) => {
        const row = await this.db.hrAction.findUnique({ where: { id }, select: { workspaceId: true } });
        return row ? workspaceMembersOf(this.db, row.workspaceId, userIds) : [];
      },
      href: () => null,
    });
    this.refs.register('employment', {
      canViewMany: async (userIds, id) => {
        const row = await this.db.employment.findUnique({ where: { id }, select: { workspaceId: true } });
        return row ? workspaceMembersOf(this.db, row.workspaceId, userIds) : [];
      },
      href: () => null,
    });
    this.refs.register('esutd_submission', {
      canViewMany: async (userIds, id) => {
        const row = await this.db.esutdSubmission.findUnique({ where: { id }, select: { workspaceId: true } });
        return row ? workspaceMembersOf(this.db, row.workspaceId, userIds) : [];
      },
      href: (_ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/members?tab=deadlines` : null),
    });
  }
}
