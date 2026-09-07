// ============================================================
// core/notifications — формы провода (обе стороны: API и клиенты)
// ============================================================
// Реестр типов и словарь движка — `../notifications` (сервис × приоритет × значок).
// Здесь — DTO ленты, счётчиков, настроек, устройств и политики организации.

import type { CursorPage } from './common';
import type { RichCardRefType } from './rich-card';
import type {
  NotificationChannel,
  NotificationPrefChannel,
  NotificationPriority,
  NotificationReason,
  NotificationServiceKey,
} from '../notifications/types';
import type { NotificationType } from '../notifications';

/** Ссылка на объект — deep link и привязка к rich-card решаются реестром движка. */
export interface NotificationRef {
  type: string;
  id: string;
}

/** Строка ленты адресата (текст собран ПРИ ЧТЕНИИ в языке запроса). */
export interface NotificationDto {
  id: string;
  /** Тип реестра; строка из прошлой версии (тип ушёл) отдаётся как есть со снимком текста */
  type: NotificationType | string;
  service: NotificationServiceKey | string;
  priority: NotificationPriority;
  /** Ключ реестра иконок веба (Phosphor) */
  icon: string;
  title: string;
  body: string | null;
  /** Куда ведёт строка: `actionUrl` продюсера, иначе `href(ref)` из реестра; null — некуда */
  href: string | null;
  ref: NotificationRef | null;
  /** Тип рич-карты, если `ref` зарегистрирован в core/rich-cards — строка раскрывается в живую карточку */
  richCardType: RichCardRefType | null;
  /** Актор ПОСЛЕДНЕГО схлопнутого события; `actorIds` — все (для «Асель и ещё 4») */
  actorId: string | null;
  actorIds: string[];
  /** Сколько событий схлопнулось в строку (1 — обычная строка) */
  collapseCount: number;
  /** Контекст строки: организация (адресат — её член) либо null = «Личное» */
  workspaceId: string | null;
  reason: NotificationReason | null;
  /** Данные последнего события — для рич-рендера клиента (только скаляры и id) */
  payload: Record<string, unknown> | null;
  seenAt: string | null;
  readAt: string | null;
  archivedAt: string | null;
  savedAt: string | null;
  snoozedUntil: string | null;
  /** Когда случилось (не меняется) */
  createdAt: string;
  /** Порядок ленты: поднимается при схлопывании и пробуждении */
  sortAt: string;
}

/** Актор строки — карточка человека (PersonChip/PersonAvatar по правилу платформы). */
export interface NotificationActorDto {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/** Организация-контекст строки (логотип/имя вместо актора у системных событий). */
export interface NotificationWorkspaceDto {
  id: string;
  name: string;
  logo: string | null;
}

/** Страница ленты — цельной, с довесками пачкой (без N+1 на клиенте). */
export interface NotificationPageDto extends CursorPage<NotificationDto> {
  actors: NotificationActorDto[];
  workspaces: NotificationWorkspaceDto[];
}

/** Бейдж = unseen; точки по контекстам — для переключателя организаций. */
export interface NotificationCountsDto {
  unseen: number;
  /** `personal` | id организации → unseen в контексте */
  byContext: Record<string, number>;
}

// ---- Настройки: сервис × канал, раскрываемые до типов ----

/** Ячейка матрицы: что действует, есть ли личное переопределение, заперто ли организацией. */
export interface NotificationChannelCellDto {
  enabled: boolean;
  /** Личное переопределение (null — дефолт) */
  override: boolean | null;
  /** Политика организации: `locked_on` — человек изменить не может */
  locked: boolean;
}

export interface NotificationTypePrefDto {
  type: NotificationType;
  priority: NotificationPriority;
  icon: string;
  channels: Record<NotificationPrefChannel, NotificationChannelCellDto>;
  smsEligible: boolean;
  /** SMS-opt-in человека для этого критичного типа */
  smsOptIn: boolean;
}

export interface NotificationServicePrefDto {
  service: NotificationServiceKey;
  channels: Record<NotificationPrefChannel, NotificationChannelCellDto>;
  /** Типы контекста (critical сюда не входят — они в `critical`) */
  types: NotificationTypePrefDto[];
}

export interface NotificationPreferencesDto {
  /** `personal` | id организации */
  context: string;
  services: NotificationServicePrefDto[];
  /** «Всегда приходят» — critical-типы контекста (доверие вместо скрытия) */
  critical: { type: NotificationType; service: NotificationServiceKey; icon: string; smsEligible: boolean; smsOptIn: boolean }[];
  /** Живой ли SMS-драйвер (блок «SMS для важного» показывается только при нём) */
  smsLive: boolean;
}

/** Правило тишины: дни недели (1 = понедельник … 7 = воскресенье) и окно `HH:MM` в поясе человека. */
export interface NotificationQuietRule {
  days: number[];
  from: string;
  to: string;
}

export interface NotificationQuietDto {
  schedule: NotificationQuietRule[] | null;
  pausedUntil: string | null;
  /** `User.timezone` — подпись «по времени Алматы» */
  timezone: string;
  /** Тишина действует прямо сейчас (расписание или пауза) */
  activeNow: boolean;
}

export const NOTIFICATION_DEVICE_PLATFORMS = ['web', 'ios', 'android'] as const;
export type NotificationDevicePlatform = (typeof NOTIFICATION_DEVICE_PLATFORMS)[number];
export const NOTIFICATION_DEVICE_PROVIDERS = ['webpush', 'expo', 'fcm'] as const;
export type NotificationDeviceProvider = (typeof NOTIFICATION_DEVICE_PROVIDERS)[number];

export interface NotificationDeviceDto {
  id: string;
  platform: NotificationDevicePlatform;
  provider: NotificationDeviceProvider;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface NotificationDeviceRegisteredDto {
  id: string;
}

// ---- Политика организации (дефолты + замки) ----

export const NOTIFICATION_POLICY_MODES = ['default_on', 'default_off', 'locked_on'] as const;
export type NotificationPolicyMode = (typeof NOTIFICATION_POLICY_MODES)[number];

export const NOTIFICATION_SUBJECT_KINDS = ['service', 'type'] as const;
export type NotificationSubjectKind = (typeof NOTIFICATION_SUBJECT_KINDS)[number];

export interface WorkspaceNotificationPolicyRuleDto {
  subjectKind: NotificationSubjectKind;
  subjectKey: string;
  channel: NotificationPrefChannel;
  mode: NotificationPolicyMode;
}

export interface WorkspaceNotificationPolicyTypeDto {
  type: NotificationType;
  priority: NotificationPriority;
  icon: string;
  lockable: boolean;
}

export interface WorkspaceNotificationPolicyServiceDto {
  service: NotificationServiceKey;
  types: WorkspaceNotificationPolicyTypeDto[];
}

export interface WorkspaceNotificationPolicyDto {
  workspaceId: string;
  rules: WorkspaceNotificationPolicyRuleDto[];
  /** B2B-сервисы и их типы — форма матрицы (critical не показываются: их не настраивают) */
  services: WorkspaceNotificationPolicyServiceDto[];
}

// ---- Dev-наблюдаемость ----

export const NOTIFICATION_DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'skipped'] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** Почему канал не сработал — видно за минуту в dev-ручке доставок. */
export const NOTIFICATION_SKIP_REASONS = [
  'pref_off',
  'policy',
  'muted',
  'quiet',
  'no_device',
  'driver_not_configured',
  'no_access',
  'actor',
  'throttled',
  'seen',
  'burst',
  'no_phone',
  'budget',
  'expired',
] as const;
export type NotificationSkipReason = (typeof NOTIFICATION_SKIP_REASONS)[number];

export interface NotificationDeliveryDto {
  id: string;
  eventId: string;
  recipient: string;
  userId: string | null;
  channel: NotificationChannel;
  notificationId: string | null;
  status: NotificationDeliveryStatus;
  skipReason: NotificationSkipReason | null;
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** Результат `send()` продюсера. */
export interface NotificationSendResult {
  eventId: string;
}

/** Публичный VAPID-ключ для подписки браузера (пусто — web push не настроен). */
export interface NotificationVapidDto {
  publicKey: string | null;
}
