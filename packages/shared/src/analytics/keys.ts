import { z } from 'zod';
import { defineAnalyticsEvents, noProps, propCode } from './types';

// ============================================================
// Ключи и вебхуки — факты сервера из транзакций мутаций (без PII: только коды и признаки)
// ============================================================

export const KEYS_ANALYTICS_EVENTS = defineAnalyticsEvents({
  'keys.bot.created': {
    service: 'keys',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ rank: propCode(16), scopeCount: z.number().int().min(0).max(64), hasAllowlist: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  'keys.key.created': {
    service: 'keys',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z
      .object({
        kind: propCode(16),
        contextType: z.enum(['personal', 'workspace']),
        hasExpiry: z.boolean(),
        hasAllowlist: z.boolean(),
        rotation: z.boolean(),
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  /** Первое обращение ключом — adoption интеграции */
  'keys.key.first_used': {
    service: 'keys',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ kind: propCode(16) }).strict(),
    version: 1,
    status: 'live',
  },
  'keys.key.revoked': {
    service: 'keys',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ kind: propCode(16), reason: propCode(32) }).strict(),
    version: 1,
    status: 'live',
  },
  'webhooks.endpoint.created': {
    service: 'webhooks',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ signing: propCode(16), eventCount: z.number().int().min(0).max(200) }).strict(),
    version: 1,
    status: 'live',
  },
  'webhooks.endpoint.disabled': {
    service: 'webhooks',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ reason: propCode(32) }).strict(),
    version: 1,
    status: 'live',
  },
  'keys.session.reuse_detected': {
    service: 'keys',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: noProps(),
    version: 1,
    status: 'live',
  },
});
