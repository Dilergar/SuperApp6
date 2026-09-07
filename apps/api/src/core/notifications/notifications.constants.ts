/**
 * Типы джобов движка уведомлений (core/jobs). Константы живут у владельца —
 * их ставят и сам движок, и продюсеры из своих транзакций.
 */
export const NOTIFICATION_JOBS = {
  /** Разворот адресатов события + строки ленты + постановка канальных джобов */
  fanout: 'notifications.fanout',
  /** Дочерний чанк массового фанаута (>500 адресатов) */
  fanoutChunk: 'notifications.fanout.chunk',
  /** Батчер push на человека (uniqueKey `push:<userId>`) */
  deliverPush: 'notifications.deliver.push',
  /** SMS по одной доставке */
  deliverSms: 'notifications.deliver.sms',
  /** Сообщение/рич-карта в чат по одной доставке (драйвер регистрирует мессенджер) */
  deliverChat: 'notifications.deliver.chat',
  /** Пробуждение отложенной строки (runAt = until, uniqueKey `snooze:<id>`) */
  unsnooze: 'notifications.unsnooze',
} as const;

/** Своя очередь: фанаут на 500 адресатов не должен занимать слоты `default`. */
export const NOTIFICATION_QUEUE = 'notifications';

/** Ключи Redis движка */
export const NOTIFICATION_REDIS = {
  throttle: (userId: string, collapseKey: string) => `ntf:thr:${userId}:${collapseKey}`,
  burst: (userId: string) => `ntf:burst:${userId}`,
  budget: (workspaceId: string) => `ntf:budget:ws:${workspaceId}`,
  smsUser: (userId: string) => `ntf:sms:u:${userId}`,
  smsWorkspace: (workspaceId: string) => `ntf:sms:ws:${workspaceId}`,
} as const;

/** Шина: сигналы realtime-relay (at-most-once допустимо — клиент перечитывает counts на reconnect). */
export const NOTIFICATION_BUS_EVENTS = {
  created: 'notifications.created',
  counts: 'notifications.counts',
} as const;
