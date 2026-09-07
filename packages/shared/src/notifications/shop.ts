import { defineNotifications } from './types';

/** My Wish & Shop: жизненный цикл заказа. `ref` = заказ (`order`) — строка раскрывается в живую рич-карту. */
export const SHOP_NOTIFICATIONS = defineNotifications({
  'shop.order.placed': { service: 'shop', priority: 'high', icon: 'cart', contexts: 'personal', collapse: 'none' },
  'shop.order.confirmed': { service: 'shop', priority: 'high', icon: 'checkCircle', contexts: 'personal', collapse: 'ref' },
  'shop.order.rejected': { service: 'shop', priority: 'high', icon: 'blocked', contexts: 'personal', collapse: 'ref' },
  'shop.order.cancelled': { service: 'shop', priority: 'normal', icon: 'undo', contexts: 'personal', collapse: 'ref' },
  'shop.order.funded': { service: 'shop', priority: 'high', icon: 'target', contexts: 'personal', collapse: 'ref' },
});
