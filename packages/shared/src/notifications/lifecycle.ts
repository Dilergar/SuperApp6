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
 * - `lifecycle.export.ready` / `lifecycle.export.failed` — заказавшему выгрузку (человек — свою,
 *   владелец — организации): архив готов на 7 дней / сборка не удалась. Ссылки на скачивание в
 *   уведомлении нет — только страница выгрузок (каждое скачивание — своя 5-минутная ссылка).
 * Payload — коды, числа и даты: класс данных ключом, срок в сутках (0 — «вечно»), дата вступления.
 */
export const LIFECYCLE_NOTIFICATIONS = defineNotifications({
  'lifecycle.export.ready': { service: 'lifecycle', priority: 'high', icon: 'download', contexts: 'both', collapse: 'none' },
  'lifecycle.export.failed': { service: 'lifecycle', priority: 'normal', icon: 'warningCircle', contexts: 'both', collapse: 'none' },
  'lifecycle.retention.changed': { service: 'lifecycle', priority: 'high', icon: 'archive', contexts: 'workspace', collapse: 'ref' },
  'lifecycle.retention.cancelled': { service: 'lifecycle', priority: 'normal', icon: 'undo', contexts: 'workspace', collapse: 'ref' },
  'lifecycle.hold.created': { service: 'lifecycle', priority: 'normal', icon: 'lock', contexts: 'workspace', collapse: 'none' },
  'lifecycle.hold.released': { service: 'lifecycle', priority: 'normal', icon: 'lock', contexts: 'workspace', collapse: 'none' },
  'lifecycle.erasure.completed': { service: 'lifecycle', priority: 'normal', icon: 'sealCheck', contexts: 'personal', collapse: 'none' },
});
