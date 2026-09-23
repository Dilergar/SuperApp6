import { z } from 'zod';
import { defineAnalyticsEvents, propCode } from './types';

// ============================================================
// Журнал безопасности (core/audit) — adoption защиты аккаунта и журнала организации.
// Свойства — только коды: фильтр, формат, источник. Ни IP, ни устройства, ни событий журнала:
// аналитика отвечает «пользуются ли», а «что случилось» — дело самого журнала.
// ============================================================

export const AUDIT_ANALYTICS_EVENTS = defineAnalyticsEvents({
  /** Лента безопасности открыта (человек — «Безопасность» профиля, организация — журнал) */
  'audit.feed.viewed': {
    service: 'audit',
    source: 'client',
    class: 'product',
    qualifying: false,
    props: z.object({ viewer: z.enum(['person', 'workspace']), filter: propCode(16) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Мастер «Это не я» доведён до конца (факт сервера) */
  'audit.not_me.completed': {
    service: 'audit',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ credentialsRotated: z.boolean(), numberConfirmed: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  /** Организация заказала выгрузку журнала (факт сервера, из транзакции заказа) */
  'audit.export.requested': {
    service: 'audit',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ format: propCode(8), filter: propCode(16) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Человек забыл устройство (факт сервера) */
  'audit.device.forgotten': {
    service: 'audit',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ sessionsRevoked: z.number().int().min(0).max(1000) }).strict(),
    version: 1,
    status: 'live',
  },
  /** Аккаунт заморожен (факт сервера): кем — `self` (человек без входа) или `platform` */
  'auth.account.frozen': {
    service: 'auth',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ by: propCode(16) }).strict(),
    version: 1,
    status: 'live',
  },
});
