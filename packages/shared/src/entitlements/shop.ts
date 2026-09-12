import { defineEntitlements } from './types';

/** Магазин: витрины — и у человека, и у организации (владелец магазина = контейнер). */
export const SHOP_ENTITLEMENTS = defineEntitlements({
  'shop.maxShowcases': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['user', 'workspace'],
    unit: 'count',
    defaultFree: 50,
    hasUsage: true,
    service: 'shop',
    labelKey: 'entitlements.keys.shopMaxShowcases',
  },
});
