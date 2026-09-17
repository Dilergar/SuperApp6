import { defineNotifications } from './types';

/**
 * Ключи, боты и вебхуки (core/keys, core/webhooks). Адресаты решает продюсер:
 * личный ключ — сам человек; ключи организации — владелец и админы (роль, не
 * человек); заморозка бота — только владелец (critical: ключи перестали работать).
 */
export const KEYS_NOTIFICATIONS = defineNotifications({
  'key.created': { service: 'keys', priority: 'high', icon: 'key', contexts: 'both', collapse: 'none' },
  // За 14 и за 1 день (одно уведомление на порог — idempotencyKey продюсера)
  'key.expiring': { service: 'keys', priority: 'high', icon: 'hourglass', contexts: 'both', collapse: 'type' },
  'key.expired': { service: 'keys', priority: 'high', icon: 'clock', contexts: 'both', collapse: 'type' },
  'key.revoked': { service: 'keys', priority: 'high', icon: 'lock', contexts: 'both', collapse: 'none' },
  // Ключ найден в открытом доступе (сигнал сканера) — отозван автоматически
  'key.leaked': { service: 'keys', priority: 'critical', icon: 'shield', contexts: 'both', collapse: 'none', smsEligible: true },
  // Обращение с нового адреса / чужого IP при allowlist
  'key.newLocation': { service: 'keys', priority: 'high', icon: 'globe', contexts: 'both', collapse: 'ref' },
  // Ключ упёрся в потолок: обращений в минуту (`rate`) или строк выгрузки в сутки (`export`) —
  // аномалия объёма (модель Salesloft), одно уведомление на ключ в сутки
  'key.throttled': { service: 'keys', priority: 'high', icon: 'hourglass', contexts: 'both', collapse: 'ref' },
  'bot.frozen': { service: 'keys', priority: 'critical', icon: 'robot', contexts: 'workspace', collapse: 'ref' },
  'bot.unfrozen': { service: 'keys', priority: 'high', icon: 'robot', contexts: 'workspace', collapse: 'ref' },
  // Именной ответственный покинул организацию — ответственность вернулась роли
  'bot.responsible.left': { service: 'keys', priority: 'high', icon: 'robot', contexts: 'workspace', collapse: 'ref' },
  'webhook.endpoint.disabled': { service: 'keys', priority: 'high', icon: 'plug', contexts: 'workspace', collapse: 'ref' },
});
