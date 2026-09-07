import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { workspaceMembersOf } from '../../core/notifications/notifications.ref-helpers';

/** Смена и объект: видят члены организации; deep link — график объекта. */
@Injectable()
export class ObjectsNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('shift', {
      canViewMany: async (userIds, shiftId) => {
        const s = await this.db.shift.findUnique({ where: { id: shiftId }, select: { workspaceId: true } });
        if (!s) return [];
        return workspaceMembersOf(this.db, s.workspaceId, userIds);
      },
      // Адрес графика знает продюсер (branchId в payload) — actionUrl всегда задан
      href: () => null,
      richCardType: 'shift',
    });
    this.refs.register('branch', {
      canViewMany: async (userIds, branchId) => {
        const b = await this.db.staffBranch.findUnique({ where: { id: branchId }, select: { workspaceId: true } });
        if (!b) return [];
        return workspaceMembersOf(this.db, b.workspaceId, userIds);
      },
      href: (ref, ctx) => (ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/objects/${ref.id}` : null),
      richCardType: 'branch',
    });
  }
}
