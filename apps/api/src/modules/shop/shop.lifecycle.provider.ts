import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { LifecycleTenantHookRegistry } from '../../core/lifecycle/lifecycle.purge.registry';
import { ShopService } from './shop.service';

/**
 * Магазин в каскаде удаления организации (`shop.owner`, политика `Shop`): магазин
 * организации закрывается — деньги живых заказов возвращаются, витрины уходят, история
 * заказов остаётся по закону.
 */
@Injectable()
export class ShopLifecycleProvider implements OnModuleInit {
  constructor(
    private readonly tenantHooks: LifecycleTenantHookRegistry,
    private readonly shop: ShopService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('shop.owner', {
      purge: (workspaceId, ctx) => this.shop.closeOwnerShop('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.showcase.count({ where: { shop: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
  }
}
