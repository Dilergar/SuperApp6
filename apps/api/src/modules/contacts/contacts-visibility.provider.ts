import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { VisibilityPolicyService } from '../../core/visibility/visibility.policy.service';
import { VisibilityPersonalGraphRegistry, type VisibilityPersonalGraphRelation } from '../../core/visibility/visibility.registry';
import { PersonalGraphRegistry } from './personal-graph.registry';

/**
 * Регистрации Окружения в движке видимости (направление «фича → движок»):
 * - личный граф глазами движка: связь, Группы субъекта со зрителем, Группы зрителя с субъектом
 *   (взаимность присутствия), общие организации — три запроса на пачку любой длины;
 * - разрыв связи (удаление контакта, блок) снимает исключения «всегда показывать» между
 *   парой (R2): они выдавались «потому что вы в окружении друг у друга».
 */
@Injectable()
export class ContactsVisibilityProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly graph: VisibilityPersonalGraphRegistry,
    private readonly hooks: PersonalGraphRegistry,
    private readonly policies: VisibilityPolicyService,
  ) {}

  onModuleInit(): void {
    this.graph.register({
      relationsOf: (viewerId, subjectIds) => this.relationsOf(viewerId, subjectIds),
      circleIdsOwnedBy: async (ownerId) => (await this.db.circle.findMany({ where: { ownerId }, select: { id: true } })).map((c) => c.id),
    });
    this.hooks.register('visibility', {
      onUnlinked: (a, b) => this.policies.onUnlinked(a, b),
    });
  }

  private async relationsOf(viewerId: string, subjectIds: readonly string[]): Promise<Map<string, VisibilityPersonalGraphRelation>> {
    const ids = [...new Set(subjectIds)].filter((id) => id && id !== viewerId);
    const out = new Map<string, VisibilityPersonalGraphRelation>();
    for (const id of ids) out.set(id, { linked: false, subjectCircleIds: [], viewerCircleIds: [], sharedWorkspaceIds: [] });
    if (!ids.length) return out;

    const [links, roles] = await Promise.all([
      this.db.contactLink.findMany({
        where: {
          OR: [
            { userAId: viewerId, userBId: { in: ids } },
            { userBId: viewerId, userAId: { in: ids } },
          ],
        },
        select: { id: true, userAId: true, userBId: true, memberships: { select: { circleId: true, circle: { select: { ownerId: true } } } } },
      }),
      // Коллеги: оба — в команде ЖИВОЙ организации (Подрядчик изолирован)
      this.db.userRole.findMany({
        where: {
          userId: { in: [viewerId, ...ids] },
          context: 'workspace',
          isActive: true,
          tenantId: { not: null },
          role: { in: [...TEAM_WORKSPACE_ROLES] },
        },
        select: { userId: true, tenantId: true },
      }),
    ]);
    for (const l of links) {
      const other = l.userAId === viewerId ? l.userBId : l.userAId;
      const rel = out.get(other);
      if (!rel) continue;
      rel.linked = true;
      for (const m of l.memberships) {
        if (m.circle.ownerId === other) rel.subjectCircleIds.push(m.circleId);
        else if (m.circle.ownerId === viewerId) rel.viewerCircleIds.push(m.circleId);
      }
    }
    const viewerWs = new Set(roles.filter((r) => r.userId === viewerId).map((r) => r.tenantId!));
    if (viewerWs.size) {
      const live = new Set(
        (await this.db.workspace.findMany({ where: { id: { in: [...viewerWs] }, isActive: true }, select: { id: true } })).map((w) => w.id),
      );
      for (const r of roles) {
        if (r.userId === viewerId || !live.has(r.tenantId!)) continue;
        const rel = out.get(r.userId);
        if (rel && !rel.sharedWorkspaceIds.includes(r.tenantId!)) rel.sharedWorkspaceIds.push(r.tenantId!);
      }
    }
    return out;
  }
}
