import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecyclePurgeHandlerRegistry, LifecycleTenantHookRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { DriveTreeService } from './drive-tree.service';

/**
 * Диск в движке сроков core/lifecycle:
 *  - `drive.trash` (политика `DriveNode`) — корзина: корни старше срока уходят навсегда тем же
 *    путём, что «удалить навсегда» (гранты, привязки, ссылки наружу, файлы, индекс), пачками;
 *  - `drive.workspace` (политика `DriveSpace`) — каскад организации: её пространства
 *    (`ownerType = workspace`) внешним ключом не связаны и без шага пережили бы её навсегда
 *    вместе с файлами, грантами и ссылками наружу.
 */
@Injectable()
export class DriveLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly tree: DriveTreeService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.handlers.register('drive.trash', {
      purgeBatch: ({ limit, cursor, releasable }) => this.tree.purgeTrashBatch({ limit, cursor, releasable }),
      estimate: () => this.tree.countTrashDue(),
    });
    this.tenantHooks.register('drive.workspace', {
      purge: (workspaceId, ctx) => this.tree.purgeOwnerSpaces('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.driveNode.count({ where: { space: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
  }
}
