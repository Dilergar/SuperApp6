import { Injectable, OnModuleInit } from '@nestjs/common';
import { WORKSPACE_LIMITS, lifecyclePolicy } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { WorkspacesService } from './workspaces.service';

/**
 * Организации в движке сроков core/lifecycle:
 *  - `workspaces.purge` (политика `Workspace`, срок — дни в архиве) — ретеншн архива: каскад
 *    удаления ставится джобом на организацию, не больше `tenantPurgesPerRun` за ночь;
 *  - `workspaces.row` — последний шаг каскада: строка организации (согласия, журнал, DELETE).
 *
 * Обещание владельцу («удалится через N дней», предупреждения за 7/3/1) и принуждение обязаны
 * совпадать: срок в `WORKSPACE_LIMITS` и в реестре расходятся — старт падает.
 */
@Injectable()
export class WorkspacesLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly workspaces: WorkspacesService,
    private readonly db: DatabaseService,
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
  }
}
