import { Injectable, OnModuleInit } from '@nestjs/common';
import { WORKSPACE_LIMITS, lifecyclePolicy } from '@superapp/shared';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
import { WorkspacesService } from './workspaces.service';

/**
 * Организации в движке сроков core/lifecycle:
 *  - `workspaces.purge` (политика `Workspace`, срок — дни в архиве) — ретеншн архива: каскад
 *    удаления ставится джобом на организацию, не больше `tenantPurgesPerRun` за ночь;
 *  - `workspaces.row` — последний шаг каскада: строка организации (согласия, журнал, DELETE);
 *  - `workspaces.subject` (политика `WorkspaceMember`) — стирание человека: выход из каждой
 *    организации путём «ушёл сам»; организация остаётся со своими записями о нём;
 *  - канарейка стирания: организация канарейки (фабрика) и посев членств и приглашения.
 *
 * Обещание владельцу («удалится через N дней», предупреждения за 7/3/1) и принуждение обязаны
 * совпадать: срок в `WORKSPACE_LIMITS` и в реестре расходятся — старт падает.
 */
@Injectable()
export class WorkspacesLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly workspaces: WorkspacesService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    const registryDays = lifecyclePolicy('Workspace')?.retention.defaultDays;
    if (registryDays !== WORKSPACE_LIMITS.archiveRetentionDays) {
      throw new Error(`archive retention mismatch: WORKSPACE_LIMITS.archiveRetentionDays=${WORKSPACE_LIMITS.archiveRetentionDays}, lifecycle registry Workspace=${String(registryDays)}`);
    }
    this.handlers.register('workspaces.purge', {
      purgeBatch: async ({ cutoff, limit, force }) => {
        const rows = await this.workspaces.purgeExpiredArchives({ cutoff: cutoff ?? undefined, limit, force });
        // Одна порция за ночь: хвост сверх потолка — следующей ночью
        return { rows, more: false };
      },
      estimate: ({ cutoff }) => this.db.workspace.count({ where: { isActive: false, archivedAt: { not: null, lt: cutoff ?? new Date(0) } } }),
    });
    this.tenantHooks.register('workspaces.row', {
      purge: (workspaceId) => this.workspaces.deleteWorkspaceRow(workspaceId),
      estimate: async (workspaceId) => ((await this.db.workspace.count({ where: { id: workspaceId } })) ? 1 : 0),
    });
    this.subjectHooks.register('workspaces.subject', { erase: (userId, ctx) => this.workspaces.eraseMemberships(userId, ctx) });
    this.canary.setWorkspaceFactory({
      create: (ownerId, memberId, name) => this.workspaces.createCanaryWorkspace(ownerId, memberId, name),
      archive: (workspaceId) => this.workspaces.archiveCanaryWorkspace(workspaceId),
    });
    this.canary.register('workspaces.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: членство человека уходит («ушёл сам»), соседа — остаётся; приглашение человеку — исчезает. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const members = await this.db.workspaceMember.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, userId: true }, take: 100 });
    const invitation = await this.db.workspaceInvitation.create({
      data: { workspaceId: ctx.workspaceId, invitedBy: ctx.peerId, toUserId: ctx.userId, toPhone: `canary:${randomUUID()}`, branchIds: [], message: ctx.marker, expiresAt: new Date(Date.now() + 3_600_000) },
      select: { id: true },
    });
    return [
      ...members.map((m) => ({ policy: 'WorkspaceMember', id: m.id, expect: m.userId === ctx.userId ? ('gone' as const) : ('kept' as const), tenant: true })),
      { policy: 'WorkspaceInvitation', id: invitation.id, expect: 'gone', tenant: true },
    ];
  }
}
