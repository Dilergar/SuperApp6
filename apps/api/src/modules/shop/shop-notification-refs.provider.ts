import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import { NotificationRefRegistry } from '../../core/notifications/notifications.registry';
import { intersect } from '../../core/notifications/notifications.ref-helpers';

/** Заказ: стороны — покупатель и продавец; строка ленты раскрывается в живую рич-карту `order` с действиями. */
@Injectable()
export class ShopNotificationRefsProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly refs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    this.refs.register('order', {
      canViewMany: async (userIds, orderId) => {
        const order = await this.db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, sellerId: true } });
        if (!order) return [];
        return intersect(userIds, [order.buyerId, order.sellerId]);
      },
      href: () => '/shop',
      richCardType: 'order',
    });
  }
}
