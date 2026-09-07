import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { workspaceMembersOf } from '../../core/notifications/notifications.ref-helpers';

/** Экземпляр процесса: видят члены организации; deep link — карточка экземпляра. */
@Injectable()
export class ProcessesNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('process_instance', {
      canViewMany: async (userIds, instanceId) => {
        const row = await this.db.processInstance.findUnique({ where: { id: instanceId }, select: { workspaceId: true } });
        return row ? workspaceMembersOf(this.db, row.workspaceId, userIds) : [];
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/processes/instances/${ref.id}` : null),
    });
  }
}
