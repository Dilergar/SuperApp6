import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES, maskIdNumber, type EntitlementsChangedBusPayload, type PlatformWorkspaceHitDto, type WsEntitlementsChanged } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { UsageProviderRegistry } from '../../core/entitlements/entitlements.registry';
import { ENTITLEMENT_BUS_EVENTS } from '../../core/entitlements/entitlements.constants';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { PlatformLookupRegistry, PlatformPanelRegistry } from '../../core/platform/platform-lookup.registry';

const WS_CONTEXT = 'workspace';
const PUSH_CHUNK = 500;

/**
 * Организации ↔ движки тарифов и кабинета:
 * - провайдеры расхода `workspace.seats` (члены trainee+ по UserRole) и `workspaces.maxOwned`;
 * - `entitlements.changed` организации → сокет всем её членам чанками (движок состава не знает);
 * - поиск и панели карточки 360 организации (маскированный БИН, состав сводкой).
 */
@Injectable()
export class WorkspacesEntitlementsProvider implements OnModuleInit {
  private readonly logger = new Logger(WorkspacesEntitlementsProvider.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly realtime: RealtimeService,
    private readonly usage: UsageProviderRegistry,
    private readonly lookup: PlatformLookupRegistry,
    private readonly panels: PlatformPanelRegistry,
  ) {}

  onModuleInit(): void {
    this.usage.register('workspace.seats', {
      count: (subject, tx) =>
        (tx ?? this.db).userRole.count({
          where: { context: WS_CONTEXT, tenantId: subject.id, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
        }),
    });
    this.usage.register('workspaces.maxOwned', {
      count: (subject, tx) => (tx ?? this.db).workspace.count({ where: { ownerId: subject.id, isActive: true } }),
    });

    this.events.on(ENTITLEMENT_BUS_EVENTS.changed).subscribe({
      next: (evt) => void this.pushToMembers(evt.payload as unknown as EntitlementsChangedBusPayload).catch((err: Error) => this.logger.warn(`push failed: ${err.message}`)),
      error: (err: Error) => this.logger.warn(`bus subscription error: ${err.message}`),
    });

    this.lookup.register({
      entity: 'workspace',
      match: async (query, limit) => {
        if (query.kind === 'uuid') {
          const w = await this.header(query.value);
          return w ? [w] : [];
        }
        if (query.kind === 'idNumber') {
          const legal = await this.db.legalEntity.findMany({ where: { bin: query.value }, select: { workspaceId: true }, take: limit });
          const ids = [...new Set(legal.map((l) => l.workspaceId))];
          return (await Promise.all(ids.map((id) => this.header(id)))).filter((w): w is PlatformWorkspaceHitDto => !!w);
        }
        if (query.kind === 'text') {
          const rows = await this.db.workspace.findMany({
            where: { name: { contains: query.value, mode: 'insensitive' } },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return (await Promise.all(rows.map((r) => this.header(r.id)))).filter((w): w is PlatformWorkspaceHitDto => !!w);
        }
        return [];
      },
      header: (id) => this.header(id),
    });

    this.panels.register({
      key: 'workspace.profile',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceProfile',
      capability: 'platform.lookup.read',
      order: 10,
      eager: true,
      load: async (_actor, id) => {
        const w = await this.db.workspace.findUnique({
          where: { id },
          select: { id: true, name: true, logo: true, industry: true, city: true, website: true, isActive: true, archivedAt: true, createdAt: true, ownerId: true, documentLanguage: true },
        });
        if (!w) return null;
        const legal = await this.db.legalEntity.findMany({ where: { workspaceId: id, archivedAt: null }, select: { id: true, name: true, bin: true }, take: 20 });
        return {
          ...w,
          createdAt: w.createdAt.toISOString(),
          archivedAt: w.archivedAt?.toISOString() ?? null,
          legalEntities: legal.map((l) => ({ id: l.id, name: l.name, binMasked: maskIdNumber(l.bin) })),
        };
      },
    });
    this.panels.register({
      key: 'workspace.members-summary',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceMembersSummary',
      capability: 'platform.lookup.read',
      order: 20,
      eager: true,
      load: async (_actor, id) => {
        const roles = await this.db.userRole.groupBy({ by: ['role'], where: { context: WS_CONTEXT, tenantId: id, isActive: true }, _count: { _all: true } });
        const members = await this.db.workspaceMember.count({ where: { workspaceId: id } });
        const pending = await this.db.workspaceInvitation.count({ where: { workspaceId: id, status: 'pending' } });
        return { members, pendingInvitations: pending, byRole: roles.map((r) => ({ role: r.role, count: r._count._all })) };
      },
    });
    this.panels.register({
      key: 'user.workspaces',
      entity: 'user',
      titleKey: 'platform.panels.userWorkspaces',
      capability: 'platform.lookup.read',
      order: 20,
      eager: true,
      load: async (_actor, userId) => {
        // Панель — СВОДКА, а не реестр: общее число человек видит в счётчиках профиля,
        // здесь потолок (у живого аккаунта организаций бывают десятки и сотни).
        const roles = await this.db.userRole.findMany({
          where: { userId, context: WS_CONTEXT, isActive: true, tenantId: { not: null } },
          select: { role: true, tenantId: true, grantedAt: true },
          orderBy: { grantedAt: 'desc' },
          take: 50,
        });
        const ids = [...new Set(roles.map((r) => r.tenantId!).filter(Boolean))];
        const ws = await this.db.workspace.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, logo: true, isActive: true, ownerId: true } });
        const byId = new Map(ws.map((w) => [w.id, w]));
        return roles
          .filter((r) => byId.has(r.tenantId!))
          .map((r) => ({ ...byId.get(r.tenantId!)!, role: r.role, since: r.grantedAt.toISOString(), owner: byId.get(r.tenantId!)!.ownerId === userId }));
      },
    });
  }

  private async header(id: string): Promise<PlatformWorkspaceHitDto | null> {
    const w = await this.db.workspace.findUnique({ where: { id }, select: { id: true, name: true, logo: true, isActive: true, ownerId: true } });
    if (!w) return null;
    // БИН в шапке — ГОЛОВНОГО юрлица (как в реквизитах); без головного — старейшее живое
    const head =
      (await this.db.legalEntity.findFirst({ where: { workspaceId: id, isHead: true, archivedAt: null }, select: { bin: true } })) ??
      (await this.db.legalEntity.findFirst({ where: { workspaceId: id, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { bin: true } }));
    return { entity: 'workspace', id: w.id, name: w.name, logo: w.logo, binMasked: maskIdNumber(head?.bin), isActive: w.isActive, ownerId: w.ownerId };
  }

  /** Снимок организации изменился → всем членам (чанками, at-most-once). */
  private async pushToMembers(payload: EntitlementsChangedBusPayload): Promise<void> {
    if (payload?.subjectType !== 'workspace' || !payload.subjectId) return;
    const members = await this.db.workspaceMember.findMany({ where: { workspaceId: payload.subjectId }, select: { userId: true } });
    const wire: WsEntitlementsChanged = { subjectType: 'workspace', subjectId: payload.subjectId };
    const ids = members.map((m) => m.userId);
    for (let i = 0; i < ids.length; i += PUSH_CHUNK) {
      this.realtime.emitToUsers(ids.slice(i, i + PUSH_CHUNK), 'entitlements:changed', wire);
    }
  }
}
