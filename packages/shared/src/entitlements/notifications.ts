import { defineEntitlements } from './types';

/**
 * Уведомления: SMS организации в сутки — расходуемая квота с суточным периодом
 * (сброс лениво тем же UPDATE, сутки по UTC). Личный потолок человека остаётся
 * анти-абьюз-константой `NOTIFICATION_LIMITS.smsPerUserDaily`: он не тарифный.
 */
export const NOTIFICATIONS_ENTITLEMENTS = defineEntitlements({
  'notifications.smsPerDay': {
    kind: 'quota',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    period: 'day',
    defaultFree: 500,
    hasUsage: true,
    service: 'notifications',
    labelKey: 'entitlements.keys.notificationsSmsPerDay',
  },
});
