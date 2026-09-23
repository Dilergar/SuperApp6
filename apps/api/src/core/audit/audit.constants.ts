// ============================================================
// core/audit — константы движка (очередь, джобы, ключи Redis, контекст AAD)
// ============================================================

export const AUDIT_QUEUE = 'audit';

export const AUDIT_JOBS = {
  /** Подписанный дайджест журнала (каждые AUDIT_DIGEST_INTERVAL_MIN минут) */
  digest: 'audit.digest',
  /** Выгрузка месячной партиции в архив и сброс по сроку */
  archive: 'audit.archive',
  /** Выгрузка журнала организацией (NDJSON/CSV → Диск) */
  export: 'audit.export',
  /** Тяжёлые детекции (распыление, подстановка) — раз в минуту */
  detect: 'audit.detect',
  /** SMS о событии безопасности, если у человека нет живого push-устройства (≤ 1 в час) */
  smsAlert: 'audit.sms_alert',
} as const;

/** Сущность AAD шифротекстов журнала (`security_events.ip_enc|ua_raw_enc`) под платформенным KEK. */
export const AUDIT_EVENT_ENTITY = 'security_event';

/** Тип ссылки уведомлений движка: событие ленты человека и событие журнала организации. */
export const AUDIT_NOTIFICATION_REF = {
  personal: 'security_event',
  workspace: 'security_org_event',
} as const;

/** Ссылка файла выгрузки организации: refId = id организации (Диск кладёт файл в «Безопасность»). */
export const AUDIT_EXPORT_REF = 'audit_export';
/** Ссылка файла выгрузки Кабинета: refId = id сотрудника-автора (в продукте не видна никому). */
export const AUDIT_PLATFORM_EXPORT_REF = 'audit_platform_export';

/** Relay realtime: событие журнала/сессии человека → `security:changed` в `user:<id>`. */
export const AUDIT_BUS_EVENTS = {
  recorded: 'audit.recorded',
} as const;

export const AUDIT_REDIS = {
  /** Отметка «видели» семейства сессии (дедуп lastSeenAt раз в 5 минут) */
  sessionSeen: (familyId: string) => `sess:seen:${familyId}`,
  /** Неудачи входа аккаунта за окно */
  loginFail: (userId: string) => `auth:fail:${userId}`,
  /** Попытки во время блокировки (итог — `audit.lockout_summary`) */
  lockedAttempts: (userId: string) => `auth:locked:attempts:${userId}`,
  /** Уровень удвоения блокировки (сутки) */
  lockLevel: (userId: string) => `auth:lock:level:${userId}`,
  /** Новизна клиента без X-Device-Id: (ua_family, страна) на 30 дней */
  unknownDevice: (userId: string, family: string, country: string) => `audit:ud:${userId}:${family}:${country}`,
  /** Первый визит в организацию с устройства/семейства */
  wsSeen: (workspaceId: string, userId: string, device: string) => `ws:seen:${workspaceId}:${userId}:${device}`,
  /** SMS-алерт «нет push-устройства» не чаще раза в час */
  smsAlert: (userId: string) => `audit:sms:${userId}`,
  /** Разовая запись (`recordOnce`) */
  once: (key: string) => `audit:once:${key}`,
  /** Схлопывание шумных отказов (ключи API) за окно */
  collapse: (key: string) => `audit:collapse:${key}`,
  /** Счётчики детекций */
  detect: (rule: string, key: string) => `audit:det:${rule}:${key}`,
  /** Сбои записи журнала за минуту — всех инстансов (детекция `audit_degraded`) */
  writeFailures: (minute: number) => `audit:det:write_fail:${minute}`,
  /** Лимит мастера «Это не я» за час */
  notMe: (userId: string) => `audit:notme:${userId}`,
  /** Агрегат просмотров журнала сотрудником за час */
  viewed: (actorId: string, hour: string) => `audit:viewed:${actorId}:${hour}`,
  /** Индекс корзин агрегата (`<actor>|<hour>`) — сброс без SCAN */
  viewedIndex: 'audit:viewed:idx',
  /** Лок крона/джоба движка */
  lock: (name: string) => `audit:lock:${name}`,
} as const;
