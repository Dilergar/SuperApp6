// ============================================================
// core/notifications — единый реестр типов (сливается из файлов сервисов)
// ============================================================
// Новый сервис = +1 файл `<service>.ts` + строка в `NOTIFICATION_SERVICES` (types.ts)
// + ключи `notifications.<type>.title` в трёх каталогах. Union `NotificationType`
// ВЫВОДИТСЯ из реестра (`keyof`), руками не пишется; страж `pnpm check:i18n`
// сверяет типы реестра с ключами каталога.

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SERVICES,
  type NotificationChannel,
  type NotificationCollapse,
  type NotificationPriority,
  type NotificationServiceKey,
  type NotificationTypeDef,
} from './types';
import { CONTACTS_NOTIFICATIONS } from './contacts';
import { TASKS_NOTIFICATIONS } from './tasks';
import { CALENDAR_NOTIFICATIONS } from './calendar';
import { MESSENGER_NOTIFICATIONS } from './messenger';
import { WORKSPACES_NOTIFICATIONS } from './workspaces';
import { STAFF_NOTIFICATIONS } from './staff';
import { OBJECTS_NOTIFICATIONS } from './objects';
import { SHOP_NOTIFICATIONS } from './shop';
import { WALLET_NOTIFICATIONS } from './wallet';
import { FINANCES_NOTIFICATIONS } from './finances';
import { DRIVE_NOTIFICATIONS } from './drive';
import { NOTES_NOTIFICATIONS } from './notes';
import { DOCUMENTS_NOTIFICATIONS } from './documents';
import { APPROVALS_NOTIFICATIONS } from './approvals';
import { SIGN_NOTIFICATIONS } from './sign';
import { HR_NOTIFICATIONS } from './hr';
import { PROCESSES_NOTIFICATIONS } from './processes';
import { OFFICE_NOTIFICATIONS } from './office';
import { RECORDER_NOTIFICATIONS } from './recorder';
import { SHARE_NOTIFICATIONS } from './share';
import { SECURITY_NOTIFICATIONS } from './security';
import { SYSTEM_NOTIFICATIONS } from './system';
import { ENTITLEMENTS_NOTIFICATIONS } from './entitlements';
import { PLATFORM_NOTIFICATIONS } from './platform';
import { KEYS_NOTIFICATIONS } from './keys';
import { CONSENTS_NOTIFICATIONS } from './consents';
import { VISIBILITY_NOTIFICATIONS } from './visibility';
import { LIFECYCLE_NOTIFICATIONS } from './lifecycle';

export * from './types';

const REGISTRY_RAW = {
  ...CONTACTS_NOTIFICATIONS,
  ...TASKS_NOTIFICATIONS,
  ...CALENDAR_NOTIFICATIONS,
  ...MESSENGER_NOTIFICATIONS,
  ...WORKSPACES_NOTIFICATIONS,
  ...STAFF_NOTIFICATIONS,
  ...OBJECTS_NOTIFICATIONS,
  ...SHOP_NOTIFICATIONS,
  ...WALLET_NOTIFICATIONS,
  ...FINANCES_NOTIFICATIONS,
  ...DRIVE_NOTIFICATIONS,
  ...NOTES_NOTIFICATIONS,
  ...DOCUMENTS_NOTIFICATIONS,
  ...APPROVALS_NOTIFICATIONS,
  ...SIGN_NOTIFICATIONS,
  ...HR_NOTIFICATIONS,
  ...PROCESSES_NOTIFICATIONS,
  ...OFFICE_NOTIFICATIONS,
  ...RECORDER_NOTIFICATIONS,
  ...SHARE_NOTIFICATIONS,
  ...SECURITY_NOTIFICATIONS,
  ...SYSTEM_NOTIFICATIONS,
  ...ENTITLEMENTS_NOTIFICATIONS,
  ...PLATFORM_NOTIFICATIONS,
  ...KEYS_NOTIFICATIONS,
  ...CONSENTS_NOTIFICATIONS,
  ...VISIBILITY_NOTIFICATIONS,
  ...LIFECYCLE_NOTIFICATIONS,
} as const satisfies Record<string, NotificationTypeDef>;

/** Union типов — выводится из реестра, а не пишется руками. */
export type NotificationType = keyof typeof REGISTRY_RAW;

/** Реестр с единой формой декларации на каждом ключе (необязательные поля читаются без сужения union). */
export const NOTIFICATION_REGISTRY: Readonly<Record<NotificationType, NotificationTypeDef>> = REGISTRY_RAW;

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_REGISTRY) as NotificationType[];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NOTIFICATION_REGISTRY, value);
}

/** Декларация типа; для строки из прошлой версии (тип ушёл из реестра) — undefined. */
export function notificationDef(type: string): NotificationTypeDef | undefined {
  return isNotificationType(type) ? (NOTIFICATION_REGISTRY[type] as NotificationTypeDef) : undefined;
}

/** Типы сервиса в порядке реестра. */
export function notificationTypesOf(service: NotificationServiceKey): NotificationType[] {
  return NOTIFICATION_TYPES.filter((t) => NOTIFICATION_REGISTRY[t].service === service);
}

/**
 * Каналы по умолчанию для приоритета (консенсус Android importance / Slack «хорошие
 * дефолты дороже гранулярности»): critical и high — in-app + push; normal и low —
 * только in-app. SMS — только critical и только по opt-in (решает движок). Chat —
 * никогда по умолчанию: это объект-получатель, а не предпочтение.
 */
export function defaultChannelsFor(priority: NotificationPriority): Record<NotificationChannel, boolean> {
  const push = priority === 'critical' || priority === 'high';
  return { inapp: true, push, sms: false, email: false, chat: false };
}

/** Эффективные дефолты типа: приоритет + переопределение из декларации. */
export function defaultChannelsOf(def: NotificationTypeDef): Record<NotificationChannel, boolean> {
  const base = defaultChannelsFor(def.priority);
  if (!def.defaultChannels) return base;
  for (const ch of NOTIFICATION_CHANNELS) {
    const v = def.defaultChannels[ch];
    if (typeof v === 'boolean') base[ch] = v;
  }
  return base;
}

/** Ключ схлопывания строки адресата по стратегии типа (продюсер может передать свой). */
export function collapseKeyFor(input: {
  type: string;
  collapse: NotificationCollapse;
  eventId: string;
  ref?: { type: string; id: string } | null;
  actorId?: string | null;
  contextKey: string;
}): string {
  switch (input.collapse) {
    case 'ref':
      return input.ref ? `${input.type}:${input.ref.type}:${input.ref.id}` : input.eventId;
    case 'ref_actor':
      return input.ref ? `${input.type}:${input.ref.type}:${input.ref.id}:${input.actorId ?? '-'}` : input.eventId;
    case 'type':
      return `${input.type}:${input.contextKey}`;
    default:
      return input.eventId;
  }
}

/**
 * Сервисы, показываемые в контексте (`personal` | id организации). `null` — СКВОЗНАЯ
 * витрина («Везде» в центре уведомлений): там уместны все, и личные тоже — иначе
 * лента, где лежат строки Финансов, не даёт отфильтровать их чипом.
 */
export function notificationServicesForContext(context: string | null): NotificationServiceKey[] {
  const personal = context === 'personal';
  return (Object.keys(NOTIFICATION_SERVICES) as NotificationServiceKey[])
    .filter((key) => {
      if (context === null) return true;
      const scope = NOTIFICATION_SERVICES[key].contexts;
      return scope === 'both' || (personal ? scope === 'personal' : scope === 'workspace');
    })
    .sort((a, b) => NOTIFICATION_SERVICES[a].order - NOTIFICATION_SERVICES[b].order);
}

/** Типы сервиса, уместные в контексте (по `contexts` типа). */
export function notificationTypesForContext(service: NotificationServiceKey, context: string): NotificationType[] {
  const personal = context === 'personal';
  return notificationTypesOf(service).filter((t) => {
    const scope = NOTIFICATION_REGISTRY[t].contexts;
    return scope === 'both' || (personal ? scope === 'personal' : scope === 'workspace');
  });
}

export const NOTIFICATION_LIMITS = {
  /** Строк на страницу ленты */
  pageSize: 30,
  /** Устройство без визита дольше — отключается (окно свежести FCM) */
  deviceStaleDays: 60,
  /** Адресатов на чанк фанаута (дочерние джобы сверх) */
  fanoutChunk: 500,
  /** Потолок адресатов одного события */
  maxRecipients: 20_000,
  /** Отложить push онлайн-адресату (presence-aware: Linear/Notion/Bitrix24) */
  presenceDelayMs: 2 * 60_000,
  /** Burst guard push: ≥ max за окно → только сводные */
  pushBurst: { windowSec: 300, max: 5 },
  /** Бюджет программируемых продюсеров: событий в час на организацию (Salesforce) */
  workspaceBudgetPerHour: 10_000,
  /** Snooze не дольше (дни) */
  maxSnoozeDays: 30,
  /**
   * SMS: суточный потолок ЧЕЛОВЕКА — анти-абьюз, не тариф. Потолок организации —
   * ключ `notifications.smsPerDay` реестра entitlements (квота с суточным периодом).
   */
  smsPerUserDaily: 10,
  /** Отказов подряд до отключения устройства */
  deviceFailuresToDisable: 3,
  /** Потолок переопределений в одном PUT настроек */
  maxPreferenceOverrides: 500,
} as const;

/** Хосты push-служб, на которые движок готов ходить с web-push (адрес — из данных → белый список). */
export const WEB_PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const;
/** Суффиксы хостов (Windows/Edge выдаёт под-домены notify.windows.com) */
export const WEB_PUSH_ENDPOINT_HOST_SUFFIXES = ['.notify.windows.com', '.push.apple.com'] as const;

export function isAllowedWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if ((WEB_PUSH_ENDPOINT_HOSTS as readonly string[]).includes(host)) return true;
  return WEB_PUSH_ENDPOINT_HOST_SUFFIXES.some((s) => host.endsWith(s));
}
