import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import {
  LifecycleCanaryRegistry,
  LifecycleSubjectHookRegistry,
  LifecycleTenantHookRegistry,
  type LifecycleCanaryContext,
  type LifecycleCanaryPlant,
} from '../../core/lifecycle/lifecycle.purge.registry';
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
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly shop: ShopService,
    private readonly db: DatabaseService,
    private readonly canary: LifecycleCanaryRegistry,
  ) {}

  onModuleInit(): void {
    this.tenantHooks.register('shop.owner', {
      purge: (workspaceId, ctx) => this.shop.closeOwnerShop('workspace', workspaceId, ctx.deadline),
      estimate: (workspaceId) => this.db.showcase.count({ where: { shop: { ownerType: 'workspace', ownerId: workspaceId } } }),
    });
    // Стирание человека: его личный магазин и вишлист (живые заказы возвращают деньги; история заказов остаётся по закону)
    this.subjectHooks.register('shop.subject', {
      erase: async (userId, ctx) => {
        const shop = await this.shop.closeOwnerShop('user', userId, ctx.deadline);
        if (!shop.done) return shop;
        return { rows: shop.rows + (await this.shop.purgeWishlist(userId)), done: true };
      },
    });
    this.canary.register('shop.subject', (ctx) => this.seedCanary(ctx));
  }

  /** Посев канарейки: личный магазин человека с витриной и его желание — исчезают. */
  private async seedCanary(ctx: LifecycleCanaryContext): Promise<LifecycleCanaryPlant[]> {
    const shop = await this.db.shop.create({ data: { ownerType: 'user', ownerId: ctx.userId, name: ctx.marker, showcases: { create: { name: ctx.marker } } }, select: { id: true } });
    const wish = await this.db.wishItem.create({ data: { ownerId: ctx.userId, title: ctx.marker, description: ctx.marker }, select: { id: true } });
    return [
      { policy: 'Shop', id: shop.id, expect: 'gone' },
      { policy: 'WishItem', id: wish.id, expect: 'gone' },
    ];
  }
}
