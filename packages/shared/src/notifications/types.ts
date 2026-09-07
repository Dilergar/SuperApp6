// ============================================================
// core/notifications (17-й платформенный движок) — словарь реестра типов
// ============================================================
// Тип уведомления — ДЕКЛАРИРУЕМАЯ сущность с метаданными (Salesforce
// CustomNotificationType, Teams activityTypes, Android notification channel), а не
// строка. Реестр называет СМЫСЛ типа: сервис, приоритет, значок, схлопывание,
// каналы по умолчанию. СЛОВА живут в каталоге `@superapp/i18n`
// (`notifications.<type>.title|body`) — строка в реестре была бы одним языком
// навсегда и сразу у трёх клиентов.

/** Каналы доставки. `inapp` — строка ленты (+realtime); прочие — драйверы движка. */
export const NOTIFICATION_CHANNELS = ['inapp', 'push', 'sms', 'email', 'chat'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Каналы, которыми человек управляет в матрице настроек (email — контракт без доставки, chat — объект-получатель, sms — отдельный блок opt-in). */
export const NOTIFICATION_PREF_CHANNELS = ['inapp', 'push'] as const;
export type NotificationPrefChannel = (typeof NOTIFICATION_PREF_CHANNELS)[number];

/**
 * Приоритет (Android importance + Novu critical):
 * - critical — неотключаем, скрыт из матрицы, пробивает тишину и mute, кандидат на SMS;
 * - high — «адресно мне» (push по умолчанию);
 * - normal — ход дел (только in-app);
 * - low — FYI (in-app, схлопывается).
 */
export const NOTIFICATION_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/**
 * Стратегия схлопывания при записи (Teams chainId / FCM collapse_key / GitHub thread):
 * непрочитанная строка адресата с тем же ключом обновляется (count++, actorIds ∪,
 * sortAt наверх), после прочтения — новая строка.
 * - none — каждое событие своей строкой;
 * - ref — по объекту (`type:refType:refId`);
 * - ref_actor — по объекту и актору;
 * - type — по типу в контексте строки (`type:<workspaceId|personal>`): «Изменено 12 ваших смен».
 */
export const NOTIFICATION_COLLAPSE_MODES = ['none', 'ref', 'ref_actor', 'type'] as const;
export type NotificationCollapse = (typeof NOTIFICATION_COLLAPSE_MODES)[number];

/** В каких контекстах сервис/тип показывается в настройках. */
export const NOTIFICATION_CONTEXT_SCOPES = ['personal', 'workspace', 'both'] as const;
export type NotificationContextScope = (typeof NOTIFICATION_CONTEXT_SCOPES)[number];

/**
 * Отношение адресата к событию (GitHub `reason`). Ставит продюсер; фильтр
 * «Упоминания» и правило «mention пробивает mute объекта» читают его.
 */
export const NOTIFICATION_REASONS = [
  'mention',
  'assigned',
  'requested',
  'participant',
  'owner',
  'manager',
  'subscribed',
  'system',
] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

/** Состояние строки ленты для фильтров витрины. */
export const NOTIFICATION_STATES = ['all', 'unread', 'saved', 'snoozed', 'archived'] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

/** Ключ контекста ленты и настроек: `personal` либо id организации. */
export const NOTIFICATION_PERSONAL_CONTEXT = 'personal' as const;

/** Значок типа — ключ реестра Phosphor веба (`icons.manifest.json`), НЕ эмодзи. */
export type NotificationIcon =
  | 'bell'
  | 'bellRinging'
  | 'tasks'
  | 'calendar'
  | 'calendarAdd'
  | 'calendarCheck'
  | 'messenger'
  | 'mentions'
  | 'people'
  | 'user'
  | 'userAdd'
  | 'handshake'
  | 'remove'
  | 'undo'
  | 'hourglass'
  | 'check'
  | 'checkCircle'
  | 'blocked'
  | 'warning'
  | 'warningCircle'
  | 'clock'
  | 'overdue'
  | 'send'
  | 'edit'
  | 'mail'
  | 'workspace'
  | 'staff'
  | 'department'
  | 'position'
  | 'graduation'
  | 'crown'
  | 'door'
  | 'archive'
  | 'broadcast'
  | 'cart'
  | 'target'
  | 'coins'
  | 'call'
  | 'record'
  | 'mic'
  | 'video'
  | 'finish'
  | 'pending'
  | 'debt'
  | 'replay'
  | 'refresh'
  | 'share'
  | 'drive'
  | 'notes'
  | 'docs'
  | 'file'
  | 'signature'
  | 'sealCheck'
  | 'link'
  | 'lock'
  | 'device'
  | 'shield'
  | 'smiley';

export interface NotificationThrottle {
  /** Окно, секунд */
  windowSec: number;
  /** Сколько событий на пару (адресат, collapseKey) в окне; сверх — `skipped: throttled` */
  max: number;
}

/** Декларация типа (метаданные; слова — в каталоге). */
export interface NotificationTypeDef {
  /** Сервис-владелец — корзина настроек «сервис × канал» (Kaspi: человек мыслит сервисом) */
  service: NotificationServiceKey;
  priority: NotificationPriority;
  icon: NotificationIcon;
  /** В каких контекстах тип бывает (фильтр матрицы настроек) */
  contexts: NotificationContextScope;
  collapse: NotificationCollapse;
  /** Переопределение каналов по умолчанию (иначе — по приоритету) */
  defaultChannels?: Partial<Record<NotificationChannel, boolean>>;
  throttle?: NotificationThrottle;
  /** Срок годности push (FCM ttl): позже — не доставлять */
  ttlSec?: number;
  /** Организация может ЗАПЕРЕТЬ тип (`locked_on`) — только B2B-типы */
  lockable?: boolean;
  /** Критичный тип, для которого возможен SMS по opt-in человека */
  smsEligible?: boolean;
}

/** Сервисы платформы как корзины настроек. Порядок = порядок в UI. */
export const NOTIFICATION_SERVICES = {
  tasks: { contexts: 'both', order: 10 },
  calendar: { contexts: 'both', order: 20 },
  messenger: { contexts: 'both', order: 30 },
  contacts: { contexts: 'personal', order: 40 },
  shop: { contexts: 'personal', order: 50 },
  wallet: { contexts: 'personal', order: 55 },
  finances: { contexts: 'personal', order: 60 },
  recorder: { contexts: 'personal', order: 65 },
  drive: { contexts: 'both', order: 70 },
  notes: { contexts: 'both', order: 75 },
  share: { contexts: 'both', order: 78 },
  workspaces: { contexts: 'both', order: 80 },
  staff: { contexts: 'workspace', order: 90 },
  objects: { contexts: 'workspace', order: 100 },
  documents: { contexts: 'workspace', order: 110 },
  approvals: { contexts: 'both', order: 120 },
  sign: { contexts: 'both', order: 130 },
  hr: { contexts: 'workspace', order: 140 },
  processes: { contexts: 'workspace', order: 150 },
  office: { contexts: 'workspace', order: 160 },
  security: { contexts: 'personal', order: 900 },
  system: { contexts: 'both', order: 950 },
} as const satisfies Record<string, { contexts: NotificationContextScope; order: number }>;

export type NotificationServiceKey = keyof typeof NOTIFICATION_SERVICES;
export const NOTIFICATION_SERVICE_KEYS = Object.keys(NOTIFICATION_SERVICES) as NotificationServiceKey[];

/** Хелпер объявления файла сервиса: сохраняет литеральные ключи и проверяет форму. */
export function defineNotifications<const T extends Record<string, NotificationTypeDef>>(defs: T): T {
  return defs;
}
