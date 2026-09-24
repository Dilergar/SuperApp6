import { Injectable, OnModuleInit } from '@nestjs/common';
import { VISIBILITY_BUS_EVENTS, VISIBILITY_WS_EVENTS, isVisibilityRecordType, type VisibilityChangedBusPayload, type WsVisibilityChanged } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterRefRegistry } from '../chatter/chatter-ref.registry';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { RealtimeRegistry } from '../realtime/realtime.registry';
import { VisibilityService, type VisibilityChange } from './visibility.service';

const MANAGER_ROLES = ['owner', 'admin'];

/**
 * Регистрации движка видимости в чужих движках (направление «фича → движок»):
 * - realtime (R6): `visibility.changed` → `visibility:changed` в личные комнаты адресатов
 *   (команда организации или сам человек) — клиент сбрасывает RQ-ключи и перечитывает план;
 * - уведомления (R5): `visibility_policy` (публикация, пауза раскрытий) — владельцу и админам,
 *   ведёт в раздел «Видимость данных»; `visibility_reveal` (раскрытие данных субъекта) — самому
 *   субъекту, ведёт в его ленту безопасности;
 * - хроника (R4): `visibility_policy` (refId = организация) читают владелец и админы.
 */
@Injectable()
export class VisibilityRealtimeProvider implements OnModuleInit {
  constructor(
    private readonly realtime: RealtimeRegistry,
    private readonly refs: NotificationRefRegistry,
    private readonly chatterRefs: ChatterRefRegistry,
    private readonly db: DatabaseService,
    private readonly visibility: VisibilityService,
  ) {}

  private async managersAmong(userIds: string[], workspaceId: string): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await this.db.userRole.findMany({
      where: { userId: { in: userIds }, context: 'workspace', tenantId: workspaceId, isActive: true, role: { in: MANAGER_ROLES } },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  onModuleInit(): void {
    this.realtime.registerRelay(VISIBILITY_BUS_EVENTS.changed, ({ payload }) => {
      const p = payload as VisibilityChangedBusPayload;
      if (!p?.userIds?.length) return null;
      const msg: WsVisibilityChanged = { ownerKind: p.ownerKind, ownerId: p.ownerId, recordType: p.recordType, pv: p.pv };
      return { rooms: p.userIds.map((id) => `user:${id}`), name: VISIBILITY_WS_EVENTS.changed, payload: msg };
    });

    this.refs.register('visibility_policy', {
      canViewMany: (userIds, workspaceId) => this.managersAmong(userIds, workspaceId),
      href: (ref) => `/workspaces/${encodeURIComponent(ref.id)}/profile/visibility`,
    });

    // Раскрытие: ссылка — лента безопасности субъекта (событие `pii.reveal` видно ему там)
    this.refs.register('visibility_reveal', {
      canViewMany: async (userIds) => userIds,
      href: () => '/profile/security',
    });

    this.chatterRefs.register('visibility_policy', {
      canView: async (viewerId, workspaceId) => (await this.managersAmong([viewerId], workspaceId)).length > 0,
    });

    // Маскировщик хроники (Э5): «было → стало» полей под правилами — глазами зрителя. Зритель —
    // из контекста запроса (ключ API/бот получает свой потолок), организация — записи хроники
    this.chatterRefs.registerMasker({
      mask: async (viewerId, spec, entry, changes) => {
        const ref = spec.refOf(entry);
        if (!isVisibilityRecordType(spec.recordType)) {
          return changes.map((c) => (spec.fieldMap[c.field] ? { ...c, from: null, to: null, raw: undefined, concealed: 'hidden' as const } : c));
        }
        const viewer = this.visibility.viewer('api', { userId: viewerId, workspaceId: ref.workspaceId ?? entry.workspaceId });
        const masked = await this.visibility.maskChanges(
          viewer,
          spec.recordType,
          { recordId: ref.recordId, subjectId: ref.subjectId, workspaceId: ref.workspaceId, branchId: ref.branchId ?? null },
          changes as unknown as VisibilityChange[],
          spec.fieldMap,
        );
        // Форма изменения та же (маскировщик меняет только from/to/raw/display и ставит concealed)
        return masked as unknown as typeof changes;
      },
    });
  }
}
