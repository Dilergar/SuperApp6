import { defineNotifications } from './types';

/**
 * Тариф и лимиты (core/entitlements). Адресаты: человек — сам себе; организация —
 * владелец и админы (через core/audiences). Одно уведомление на порог за период:
 * `collapse: 'type'` + ключ периода в payload (`periodKey`).
 */
export const ENTITLEMENTS_NOTIFICATIONS = defineNotifications({
  // Пробный период заканчивается (за 7 и за 1 день)
  'entitlement.trial.ending': { service: 'entitlements', priority: 'high', icon: 'hourglass', contexts: 'both', collapse: 'type' },
  'entitlement.trial.expired': { service: 'entitlements', priority: 'high', icon: 'clock', contexts: 'both', collapse: 'type' },
  // Неоплата: льготный период начался / тариф истёк — значения свободной ступени
  'entitlement.subscription.grace': { service: 'entitlements', priority: 'high', icon: 'warning', contexts: 'both', collapse: 'type' },
  'entitlement.subscription.expired': { service: 'entitlements', priority: 'high', icon: 'lock', contexts: 'both', collapse: 'type' },
  // Квота (Диск, SMS): 80 % и 100 %
  'entitlement.quota.threshold': { service: 'entitlements', priority: 'normal', icon: 'warningCircle', contexts: 'both', collapse: 'type' },
  'entitlement.quota.exhausted': { service: 'entitlements', priority: 'high', icon: 'blocked', contexts: 'both', collapse: 'type' },
  // Места организации кончились — владельцу и админам
  'entitlement.seats.exhausted': { service: 'entitlements', priority: 'high', icon: 'staff', contexts: 'workspace', collapse: 'type' },
  // Тариф субъекта изменён кабинетом платформы (подписка, грант, индивидуальное условие):
  // владелец данных обязан узнавать об изменении своих прав, даже когда его внесла
  // поддержка. Кто именно из сотрудников — внутреннее дело кабинета и в payload не едет.
  'entitlement.support.changed': { service: 'entitlements', priority: 'high', icon: 'crown', contexts: 'both', collapse: 'type' },
});
