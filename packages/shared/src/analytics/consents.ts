import { z } from 'zod';
import { defineAnalyticsEvents, propCode } from './types';

// ============================================================
// Согласия (core/consents) — воронка принятия документов. Свойства — только коды:
// ключ документа, пакет, канал. Ни текста, ни версии-как-строки, ни PII.
// ============================================================

export const CONSENTS_ANALYTICS_EVENTS = defineAnalyticsEvents({
  /** Шаг 1 регистрации показал галочки пакета — до аккаунта, анонимно */
  'consents.registration.shown': {
    service: 'consents',
    source: 'client',
    class: 'product',
    qualifying: false,
    anonymous: true,
    props: z.object({ bundle: propCode(32) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Приёмка записана (факт сервера, из транзакции приёмки) */
  'consents.document.accepted': {
    service: 'consents',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ document: propCode(32), bundle: propCode(32).optional(), subject: z.enum(['user', 'workspace']), channel: propCode(16), version: z.number().int().min(1).max(100_000) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Отзыв / отказ (факт сервера) */
  'consents.document.revoked': {
    service: 'consents',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ document: propCode(32), reason: propCode(32) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Блокирующий экран показан */
  'consents.gate.shown': {
    service: 'consents',
    source: 'client',
    class: 'product',
    qualifying: false,
    props: z.object({ documents: z.number().int().min(1).max(16) }).strict(),
    version: 1,
    status: 'live',
  },
  /** На блокирующем экране выбрано «Не принимаю» (ведёт к удалению аккаунта) */
  'consents.gate.declined': {
    service: 'consents',
    source: 'client',
    class: 'product',
    qualifying: false,
    props: z.object({ documents: z.number().int().min(1).max(16) }).strict(),
    version: 1,
    status: 'live',
  },
});
