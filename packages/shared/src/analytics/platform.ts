import { z } from 'zod';
import { ANALYTICS_AREA_KEYS, defineAnalyticsEvents, noProps, propCode, propCount, propRoute } from './types';

// ============================================================
// Ядро платформы: навигация, вход, организации, тарифы, уведомления, ссылки, сама аналитика
// ============================================================

const areaSchema = z.enum(ANALYTICS_AREA_KEYS as [string, ...string[]]);
const workspaceRoleSchema = z.enum(['owner', 'admin', 'manager', 'staff', 'trainee', 'contractor']);
const subjectTypeSchema = z.enum(['user', 'workspace', 'family']);

export const PLATFORM_ANALYTICS_EVENTS = defineAnalyticsEvents({
  // ---- Навигация: единственный автоматический клиентский вид ----
  'navigation.page.viewed': {
    service: 'navigation',
    source: 'client',
    class: 'telemetry',
    qualifying: true,
    anonymous: true,
    props: z
      .object({
        route: propRoute(),
        service: areaSchema,
        referrerRoute: propRoute().optional(),
      })
      .strict(),
    version: 1,
    status: 'live',
  },

  // ---- Вход и регистрация (воронка до аккаунта — клиент, анонимно) ----
  'auth.registration.opened': {
    service: 'auth',
    source: 'client',
    class: 'product',
    qualifying: false,
    anonymous: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'auth.registration.phone_submitted': {
    service: 'auth',
    source: 'client',
    class: 'product',
    qualifying: false,
    anonymous: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'auth.registration.code_submitted': {
    service: 'auth',
    source: 'client',
    class: 'product',
    qualifying: false,
    anonymous: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'auth.login.opened': {
    service: 'auth',
    source: 'client',
    class: 'product',
    qualifying: false,
    anonymous: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'auth.user.registered': {
    service: 'auth',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ verified: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  'auth.user.logged_in': {
    service: 'auth',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'auth.password.reset': {
    service: 'auth',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: noProps(),
    version: 1,
    status: 'live',
  },

  // ---- Организации ----
  'workspaces.workspace.created': {
    service: 'workspaces',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'workspaces.invitation.sent': {
    service: 'workspaces',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ role: workspaceRoleSchema }).strict(),
    version: 1,
    status: 'live',
  },
  'workspaces.invitation.accepted': {
    service: 'workspaces',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ role: workspaceRoleSchema }).strict(),
    version: 1,
    status: 'live',
  },
  'workspaces.workspace.archived': {
    service: 'workspaces',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: noProps(),
    version: 1,
    status: 'live',
  },

  // ---- Тариф и лимиты ----
  'entitlements.access.denied': {
    service: 'entitlements',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ key: propCode(100), code: propCode(64), contextType: subjectTypeSchema }).strict(),
    version: 1,
    status: 'live',
  },
  'entitlements.subscription.started': {
    service: 'entitlements',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z
      .object({
        subscriptionPlan: propCode(64),
        subscriptionVersion: propCount(),
        status: propCode(32),
        origin: propCode(32),
        contextType: subjectTypeSchema,
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  'entitlements.subscription.changed': {
    service: 'entitlements',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z
      .object({
        subscriptionPlan: propCode(64),
        subscriptionVersion: propCount(),
        previousPlan: propCode(64).optional(),
        direction: z.enum(['up', 'down', 'same']),
        status: propCode(32),
        contextType: subjectTypeSchema,
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  'entitlements.subscription.expired': {
    service: 'entitlements',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ subscriptionPlan: propCode(64), contextType: subjectTypeSchema }).strict(),
    version: 1,
    status: 'live',
  },
  'entitlements.paywall.shown': {
    service: 'entitlements',
    source: 'client',
    class: 'product',
    qualifying: false,
    props: z.object({ key: propCode(100), surface: z.enum(['inline', 'modal', 'page']) }).strict(),
    version: 1,
    status: 'live',
  },
  // Отправителя пока нет: у замка тарифа нет кнопки (решение продукта). Ключ объявлен
  // заранее — кнопка смены тарифа придёт вместе с тарифами: тогда `track` у кнопки и live.
  'entitlements.paywall.clicked': {
    service: 'entitlements',
    source: 'client',
    class: 'product',
    qualifying: true,
    props: z.object({ key: propCode(100), surface: z.enum(['inline', 'modal', 'page']) }).strict(),
    version: 1,
    status: 'planned',
  },

  // ---- Уведомления ----
  'notifications.notification.read': {
    service: 'notifications',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z.object({ count: propCount(), scope: z.enum(['ids', 'all']) }).strict(),
    version: 1,
    status: 'live',
  },

  // ---- Ссылки наружу: гостевой факт, без личности ----
  'share.link.opened': {
    service: 'share',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ refType: propCode(64) }).strict(),
    version: 1,
    status: 'live',
  },

  // ---- Сама аналитика ----
  'analytics.consent.changed': {
    service: 'analytics',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ optOut: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
  'analytics.identity.linked': {
    service: 'analytics',
    source: 'server',
    class: 'business',
    qualifying: false,
    props: z.object({ contested: z.boolean() }).strict(),
    version: 1,
    status: 'live',
  },
});
