import { Injectable, OnModuleInit } from '@nestjs/common';
import { TEAM_WORKSPACE_ROLES, type AudienceContext, type SearchResultItem } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AudiencesRegistry } from '../../core/audiences/audiences.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { fullName } from '../../shared/utils/user-name';
import { OrgGraphService } from './org-graph.service';
import {
  branchHeadHolders,
  holdersForPosition,
  managerOf,
  orgToday,
  pickAssignment,
  subordinateIdsOf,
} from './org-resolve';

const WS_CONTEXT = 'workspace';

/**
 * Регистрации оргструктуры в движках — одним файлом (паттерн CounterpartiesRegistriesProvider):
 *   - core/audiences: относительные адресаты `manager_of` / `subordinates_of` /
 *     `branch_head_of` — единственный санкционированный вход «кто мой руководитель»
 *     для чужих сервисов (согласования, кампании, процессы, эскалация);
 *   - core/search: отдел/должность → `/members/org?focus=` (живой провайдер).
 * Движки про оргструктуру не знают — сервис регистрируется в них сам.
 */
@Injectable()
export class StaffRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly graph: OrgGraphService,
    private readonly audiences: AudiencesRegistry,
    private readonly search: SearchRegistry,
  ) {}

  onModuleInit(): void {
    // ---- Руководитель человека (по факту назначений; вершина → владелец) ----
    this.audiences.register('manager_of', {
      resolve: async (userId, ctx) => {
        if (!ctx.workspaceId) return [];
        const g = await this.graph.load(ctx.workspaceId);
        if (!g.memberRole.has(userId)) return [];
        return managerOf(g, userId, { branchId: ctx.branchId ?? null }).userIds;
      },
      label: (userId, ctx) => this.personLabel('Руководитель', userId, ctx),
    });

    // ---- Команда человека (точная инверсия managerOf по всем назначениям) ----
    this.audiences.register('subordinates_of', {
      resolve: async (userId, ctx, limit) => {
        if (!ctx.workspaceId) return [];
        const g = await this.graph.load(ctx.workspaceId);
        if (!g.memberRole.has(userId)) return [];
        return subordinateIdsOf(g, userId).slice(0, limit);
      },
      label: (userId, ctx) => this.personLabel('Команда', userId, ctx),
    });

    // ---- Руководитель объекта: объекта по id ЛИБО объекта человека (основное место / ctx.branchId) ----
    this.audiences.register('branch_head_of', {
      resolve: async (id, ctx) => {
        if (!ctx.workspaceId) return [];
        const g = await this.graph.load(ctx.workspaceId);
        const at = orgToday();
        // Объекты — дерево: у этажа своей управляющей должности может не быть,
        // тогда отвечает голова здания, затем площадки (branchHeadHolders).
        const branch = g.branchById.get(id);
        if (branch) return branchHeadHolders(g, branch.id, at).userIds;
        if (!g.memberRole.has(id)) return [];
        const a = pickAssignment(g, id, { branchId: ctx.branchId ?? null });
        if (!a) return [];
        return branchHeadHolders(g, a.branchId, at, id).userIds;
      },
      label: async (id, ctx) => {
        if (ctx.workspaceId) {
          const b = await this.db.staffBranch.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { name: true } });
          if (b) return `Руководитель объекта «${b.name}»`;
        }
        return this.personLabel('Руководитель объекта', id, ctx);
      },
    });

    // ---- Поиск: отделы и должности организаций зрителя ----
    this.search.register({
      type: 'org_unit',
      label: 'Оргструктура',
      search: (viewerId, query, opts) => this.searchUnits(viewerId, query, opts),
    });
  }

  private async personLabel(prefix: string, userId: string, ctx: AudienceContext): Promise<string | null> {
    void ctx;
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? `${prefix}: ${fullName(u)}` : null;
  }

  /** Живой провайдер: отдел/должность по подстроке имени — только в организациях команды зрителя */
  private async searchUnits(viewerId: string, query: string, opts: SearchProviderOpts): Promise<SearchProviderResult> {
    const q = query.trim();
    if (q.length < 2) return { items: [] };
    const roles = await this.db.userRole.findMany({
      where: { userId: viewerId, context: WS_CONTEXT, isActive: true, tenantId: { not: null }, role: { in: [...TEAM_WORKSPACE_ROLES] } },
      select: { tenantId: true },
    });
    const wsIds = [...new Set(roles.map((r) => r.tenantId).filter((x): x is string => !!x))];
    if (!wsIds.length) return { items: [] };
    const take = Math.max(1, Math.min(opts.limit, 20));
    const [deps, poss] = await Promise.all([
      this.db.staffDepartment.findMany({
        where: { workspaceId: { in: wsIds }, name: { contains: q, mode: 'insensitive' } },
        select: { id: true, name: true, workspaceId: true, createdAt: true, workspace: { select: { name: true } } },
        take,
      }),
      this.db.staffPosition.findMany({
        where: { workspaceId: { in: wsIds }, name: { contains: q, mode: 'insensitive' } },
        select: { id: true, name: true, workspaceId: true, createdAt: true, workspace: { select: { name: true } }, department: { select: { name: true } } },
        take,
      }),
    ]);
    const items: SearchResultItem[] = [
      ...deps.map((d) => ({
        type: 'org_unit' as const,
        id: `department:${d.id}`,
        title: d.name,
        snippet: `Отдел · ${d.workspace.name}`,
        url: `/workspaces/${d.workspaceId}/members/org?focus=department:${d.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: d.createdAt.toISOString(),
        score: 1,
      })),
      ...poss.map((p) => ({
        type: 'org_unit' as const,
        id: `position:${p.id}`,
        title: p.name,
        snippet: `Должность${p.department ? ` · ${p.department.name}` : ''} · ${p.workspace.name}`,
        url: `/workspaces/${p.workspaceId}/members/org?focus=position:${p.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: p.createdAt.toISOString(),
        score: 1,
      })),
    ].slice(0, take);
    return { items };
  }
}
