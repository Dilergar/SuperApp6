import { z } from 'zod';
import { defineAnalyticsEvents } from './types';

// ============================================================
// Мессенджер — факты сервера (содержимое сообщений не участвует НИКОГДА)
// ============================================================

export const MESSENGER_ANALYTICS_EVENTS = defineAnalyticsEvents({
  'messenger.chat.created': {
    service: 'messenger',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ kind: z.enum(['dm', 'group', 'context']) }).strict(),
    version: 1,
    status: 'live',
  },
  'messenger.message.sent': {
    service: 'messenger',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z
      .object({
        kind: z.enum(['text', 'attachment', 'voice']),
        hasMention: z.boolean(),
        chatKind: z.enum(['dm', 'group', 'context']),
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  /**
   * Отправка не удалась НА КЛИЕНТЕ: пузырь остался «Не отправлено · Повторить».
   * Серверного факта тут нет по определению — запрос до сервера мог не дойти.
   * Свойства — только коды: ни текста сообщения, ни адресата.
   */
  'messenger.message.send_failed': {
    service: 'messenger',
    source: 'client',
    class: 'telemetry',
    qualifying: false,
    props: z
      .object({
        kind: z.enum(['text', 'attachment']),
        /** Классификация отказа: сети не было | сервер отказал | исход неизвестен */
        reason: z.enum(['network', 'server', 'unknown_outcome']),
        /** Сколько раз транспорт уже повторял сам до того, как сдался */
        autoRetries: z.number().int().min(0).max(10),
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  /** Человек нажал «Повторить» у неотправленного пузыря (тот же ключ повтора). */
  'messenger.message.send_retried': {
    service: 'messenger',
    source: 'client',
    class: 'telemetry',
    qualifying: false,
    props: z.object({ kind: z.enum(['text', 'attachment']) }).strict(),
    version: 1,
    status: 'live',
  },
});
