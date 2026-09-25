import { defineNotifications } from './types';

/**
 * Жизненный цикл данных организации (core/lifecycle). Адресатов решает продюсер:
 * - `lifecycle.retention.changed` — ВСЕМ членам организации (кроме автора): срок хранения
 *   класса данных изменён; сокращение вступает через 30 дней — до этого доступен экспорт;
 * - `lifecycle.retention.cancelled` — всем членам: отложенное сокращение отменено;
 * - `lifecycle.hold.created` / `lifecycle.hold.released` — владельцу и админам организации
 *   (хранителю — никогда: заморозка тихая, модель Dropbox/M365);
 * - `lifecycle.erasure.completed` — владельцу стёртой организации: все этапы пройдены,
 *   сертификат подписан (код квитанции в уведомление не кладётся — payload лежит в базе
 *   открыто, а код знает только владелец).
 * Payload — коды, числа и даты: класс данных ключом, срок в сутках (0 — «вечно»), дата вступления.
 */
export const LIFECYCLE_NOTIFICATIONS = defineNotifications({
  'lifecycle.retention.changed': { service: 'lifecycle', priority: 'high', icon: 'archive', contexts: 'workspace', collapse: 'ref' },
  'lifecycle.retention.cancelled': { service: 'lifecycle', priority: 'normal', icon: 'undo', contexts: 'workspace', collapse: 'ref' },
  'lifecycle.hold.created': { service: 'lifecycle', priority: 'normal', icon: 'lock', contexts: 'workspace', collapse: 'none' },
  'lifecycle.hold.released': { service: 'lifecycle', priority: 'normal', icon: 'lock', contexts: 'workspace', collapse: 'none' },
  'lifecycle.erasure.completed': { service: 'lifecycle', priority: 'normal', icon: 'sealCheck', contexts: 'personal', collapse: 'none' },
});
