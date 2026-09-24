import { Injectable, OnModuleInit } from '@nestjs/common';
import { FIN_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { FinancesService } from './finances.service';

/**
 * Финансы в движке сроков core/lifecycle:
 *  - `finances.trash` (политика `FinTransaction`) — удалённая операция скрыта
 *    `FIN_LIMITS.trashRetentionDays`, дальше строка уходит (снимок остаётся в журнале книги);
 *  - `finances.owner` (политики `FinBook`, `FinAuditLog`) — каскад организации: её книга.
 */
@Injectable()
export class FinancesLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly finances: FinancesService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('finances.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.finances.purgeTrashBatch({ before: this.cutoff(), limit, cursor, releasable }),
      estimate: () => this.finances.countTrashDue(this.cutoff()),
    });
    this.tenantHooks.register('finances.owner', {
      purge: (workspaceId, ctx) => this.finances.purgeOwnerBook('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.finTransaction.count({ where: { book: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - FIN_LIMITS.trashRetentionDays * 86_400_000);
  }
}
