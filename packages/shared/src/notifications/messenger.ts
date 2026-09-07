import { defineNotifications } from './types';

/**
 * Мессенджер. Упоминание — уведомление с `ref` на сообщение (`chat_message`) и
 * `reason: 'mention'` (вкладка «Упоминания» = фильтр ленты; отдельной модели нет).
 * Пропущенный звонок схлопывается по собеседнику: «Асель звонила ×3».
 */
export const MESSENGER_NOTIFICATIONS = defineNotifications({
  'mention.received': { service: 'messenger', priority: 'high', icon: 'mentions', contexts: 'both', collapse: 'none' },
  'call.missed': { service: 'messenger', priority: 'high', icon: 'call', contexts: 'both', collapse: 'ref_actor' },
  'messenger.scheduled.sent': { service: 'messenger', priority: 'normal', icon: 'clock', contexts: 'both', collapse: 'none' },
});
