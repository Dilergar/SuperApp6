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
});
