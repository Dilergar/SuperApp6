import { Injectable, OnModuleInit } from '@nestjs/common';
import { FIN_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecyclePurgeHandlerRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
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
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly finances: FinancesService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
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
    // Стирание человека: его личная книга (операции, счета, гранты, журнал книги — loose FK)
    this.subjectHooks.register('finances.subject', { erase: (userId, ctx) => this.finances.purgeOwnerBook('user', userId, ctx.deadline) });
    // Посев канарейки: личная книга человека — исчезает целиком (счета, операции, люди — каскадом)
    this.canary.register('finances.subject', async (ctx) => {
      const book = await this.db.finBook.create({ data: { ownerType: 'user', ownerId: ctx.userId, name: ctx.marker }, select: { id: true } });
      return [{ policy: 'FinBook', id: book.id, expect: 'gone' }] satisfies LifecycleCanaryPlant[];
    });
  }

  private cutoff(): Date {
    return new Date(Date.now() - FIN_LIMITS.trashRetentionDays * 86_400_000);
  }
}
