import { Injectable, OnModuleInit } from '@nestjs/common';
import type { WsSecurityChanged } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { RealtimeRegistry } from '../realtime/realtime.registry';
import { AUDIT_BUS_EVENTS, AUDIT_NOTIFICATION_REF } from './audit.constants';

/**
 * Регистрации журнала в чужих движках (направление «фича → движок»):
 * - realtime: `audit.recorded` → `security:changed` в личную комнату — раздел «Безопасность»
 *   перечитывает сессии и ленту без перезагрузки (новый вход с другого устройства виден сразу);
 * - уведомления: ссылка `security_event` открывает модалку события в профиле, `security_org_event` —
 *   в журнале организации; адресат обязан видеть событие В СВОЕЙ проекции (отсев фанаута).
 */
@Injectable()
export class AuditRealtimeProvider implements OnModuleInit {
  constructor(
    private readonly realtime: RealtimeRegistry,
    private readonly refs: NotificationRefRegistry,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.realtime.registerRelay(AUDIT_BUS_EVENTS.recorded, ({ payload }) => {
      const p = payload as { userId?: string; kind?: 'event' | 'session'; id?: string };
      if (!p?.userId) return null;
      const msg: WsSecurityChanged = { kind: p.kind === 'session' ? 'session' : 'event', id: p.id ?? null };
      return { rooms: [`user:${p.userId}`], name: 'security:changed', payload: msg };
    });

    this.refs.register(AUDIT_NOTIFICATION_REF.personal, {
      canViewMany: async (userIds, refId) => {
        if (!/^\d{1,19}$/.test(refId)) return [];
        const row = await this.db.securityEvent.findFirst({ where: { id: BigInt(refId), visSubject: true }, select: { subjectUserId: true } });
        return row?.subjectUserId && userIds.includes(row.subjectUserId) ? [row.subjectUserId] : [];
      },
      href: (ref) => `/profile/security?e=${encodeURIComponent(ref.id)}`,
    });

    this.refs.register(AUDIT_NOTIFICATION_REF.workspace, {
      canViewMany: async (userIds, refId) => {
        // refId = `<workspaceId>:<eventId|export>` — адресаты: владелец и админы организации
        const [workspaceId] = refId.split(':');
        if (!workspaceId || !userIds.length) return [];
        const rows = await this.db.userRole.findMany({
          where: { userId: { in: userIds }, context: 'workspace', tenantId: workspaceId, role: { in: ['owner', 'admin'] }, isActive: true },
          select: { userId: true },
        });
        return [...new Set(rows.map((r) => r.userId))];
      },
      href: (ref) => {
        const [workspaceId, eventId] = ref.id.split(':');
        return workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/security${eventId && /^\d+$/.test(eventId) ? `?e=${eventId}` : ''}` : null;
      },
    });
  }
}
