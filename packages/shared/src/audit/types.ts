import { z } from 'zod';
import type { NotificationType } from '../notifications';
import type { AuditVocab } from './vocab';

// ============================================================
// core/audit (26-й платформенный движок) — словарь реестра СОБЫТИЙ БЕЗОПАСНОСТИ
// ============================================================
// Событие безопасности — ДЕКЛАРИРУЕМАЯ сущность (Google Cloud Audit Logs `methodName`,
// AWS CloudTrail `eventName`, OWASP Logging Vocabulary), а не строка в коде. Реестр
// называет смысл: категорию, серьёзность, КТО ИЗ ТРЁХ ЗРИТЕЛЕЙ видит событие (сам человек,
// админ организации, безопасность платформы), можно ли его оспорить («Это не я»), какое
// уведомление оно рождает и СТРОГУЮ схему деталей. Слова (заголовок и строка ленты)
// живут в `@superapp/i18n` (`audit.events.<key>.title|body`).
//
// Правило записи: событие пишется В ТРАНЗАКЦИИ факта (`audit.record(tx, …)`) — откат
// факта = записи нет, записи нет = факта нет. `tx = null` — только там, где факта в БД
// нет вовсе (неудачный вход, просмотр в Кабинете, агрегат чтений ПДн).

/**
 * Категории — они же корзины фильтров, ключи стрима наружу (`security.<category>`) и
 * smallint-код колонки `category`. Категория = первый сегмент ключа; единственное
 * исключение — семейство `auth.session.*` (категория `session`): сессии и устройства —
 * отдельная тема для человека и отдельный стрим для SIEM.
 */
export const AUDIT_CATEGORIES = ['auth', 'session', 'account', 'org', 'keys', 'platform', 'pii', 'pd', 'consents', 'data', 'detect', 'audit'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const AUDIT_CATEGORY_CODE: Record<AuditCategory, number> = {
  auth: 0,
  session: 1,
  account: 2,
  org: 3,
  keys: 4,
  platform: 5,
  pii: 6,
  pd: 7,
  consents: 8,
  data: 9,
  detect: 10,
  audit: 11,
};

/** Серьёзность (OCSF severity_id 1..5; smallint 0..4 в колонке). */
export const AUDIT_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export const AUDIT_SEVERITY_CODE: Record<AuditSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Исход (OCSF status). `denied` — отказ правом/политикой; `failure` — ошибка/неверные данные. */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'unknown'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export const AUDIT_OUTCOME_CODE: Record<AuditOutcome, number> = { success: 0, failure: 1, denied: 2, unknown: 3 };

/**
 * Род актора — выводится из АУТЕНТИФИКАЦИИ, не из тела запроса:
 * - user — человек своей сессией; bot — ключ бота; platform_staff — сотрудник платформы
 *   в Кабинете; system — крон/джоб/скрипт; guest — гость ссылки; anonymous — до входа
 *   (неудачный вход, заморозка без входа); device — терминал/IoT (этап 4).
 */
export const AUDIT_ACTOR_KINDS = ['user', 'bot', 'platform_staff', 'system', 'guest', 'anonymous', 'device'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
export const AUDIT_ACTOR_KIND_CODE: Record<AuditActorKind, number> = { user: 0, bot: 1, platform_staff: 2, system: 3, guest: 4, anonymous: 5, device: 6 };

/** Клиент запроса (smallint): веб, мобильный веб, нативное приложение, ключ API, Кабинет, сокет, джоб, скрипт. */
export const AUDIT_CLIENTS = ['web', 'mobile_web', 'mobile', 'api_key', 'console', 'socket', 'job', 'script'] as const;
export type AuditClient = (typeof AUDIT_CLIENTS)[number];
export const AUDIT_CLIENT_CODE: Record<AuditClient, number> = { web: 0, mobile_web: 1, mobile: 2, api_key: 3, console: 4, socket: 5, job: 6, script: 7 };

/** Класс устройства для человека (иконка и подпись «телефон / компьютер»). */
export const AUDIT_DEVICE_CLASSES = ['desktop', 'mobile', 'tablet', 'other'] as const;
export type AuditDeviceClass = (typeof AUDIT_DEVICE_CLASSES)[number];

/** Три зрителя одного события. `counterparty` — вторая сторона (v2: «сотрудник магазина смотрел ваш заказ»), пока только поле. */
export interface AuditVisibility {
  subject: boolean;
  workspace: boolean;
  /** Платформа видит ВСЁ — страж требует true у каждого ключа */
  platform: true;
  counterparty?: boolean;
}

/** Готовые наборы зрителей (одно событие — до трёх зрителей). */
export const AUDIT_VIS = {
  /** Только сам человек (и платформа): личные входы организации не видны НИКОГДА */
  subject: { subject: true, workspace: false, platform: true },
  /** Организация (и платформа): ключи и интеграции организации, агрегат чтений ПДн */
  workspace: { subject: false, workspace: true, platform: true },
  /** Человек и его организация: членство, роль, первый вход в организацию */
  both: { subject: true, workspace: true, platform: true },
  /** Только безопасность платформы: действия сотрудников, детекции, служебное */
  platform: { subject: false, workspace: false, platform: true },
} as const satisfies Record<string, AuditVisibility>;

/** Откуда движок берёт `subject_user_id`, если вызывающий его не назвал. */
export type AuditSubjectFrom = 'actor' | 'target' | 'explicit';

/**
 * Жизненный цикл ключа: live — пишется; planned — объявлен заранее (детекция ждёт
 * GeoIP с ASN), отправителя ещё нет; страж требует перевести в live, как только его
 * начали писать.
 */
export const AUDIT_EVENT_STATUSES = ['live', 'planned'] as const;
export type AuditEventStatus = (typeof AUDIT_EVENT_STATUSES)[number];

/** Схема деталей: СТРОГИЙ объект — только коды, id, счётчики и признаки; свободного текста нет. */
export type AuditDetailsSchema = z.ZodObject<z.ZodRawShape, 'strict'>;

/** Класс и действие OCSF 1.x для экспорта во внешний SIEM (маппер — `ocsf.ts`). */
export interface AuditOcsf {
  classUid: number;
  activityId: number;
}

/** Декларация события. */
export interface AuditEventDef {
  category: AuditCategory;
  severity: AuditSeverity;
  visibility: AuditVisibility;
  /** Человек может нажать «Это не я» (мастер защиты аккаунта) */
  disputable?: boolean;
  /**
   * Уведомление, которое событие рождает субъекту В ТОЙ ЖЕ транзакции (движок зовёт
   * `notifications.send(tx, …)` сам — продюсер не дублирует). Параметры текста —
   * устройство и страна из контекста + детали события.
   */
  notify?: NotificationType;
  /** Allow-list деталей: `.strict()`, ≤ 16 полей, имена без запрещённых слов */
  details: AuditDetailsSchema;
  /** Имя события OWASP Logging Vocabulary (внешний словарь для SIEM) */
  vocab?: AuditVocab;
  ocsf: AuditOcsf;
  /** По умолчанию `explicit` — субъекта называет вызывающий */
  subjectFrom?: AuditSubjectFrom;
  /** Окно ленты человека (365 дн) не режет: законный учёт действий с ПДн (`pd`, `consents`) */
  windowExempt?: true;
  status?: AuditEventStatus;
}

/** Хелпер объявления файла области: сохраняет литеральные ключи и точные схемы. */
export function defineAuditEvents<const T extends Record<string, AuditEventDef>>(defs: T): T {
  return defs;
}

/** Категория ключа — первый сегмент; `auth.session.*` — категория `session`. */
export function auditCategoryOfKey(key: string): string {
  return key.startsWith('auth.session.') ? 'session' : key.split('.')[0]!;
}

// ---- Строительные блоки деталей (только они: так свободный текст не пролезает) ----

/** Пустой набор деталей. */
export const noDetails = () => z.object({}).strict();
/** Короткий машинный код (ключ команды, причина, тип цели) — не текст человека. */
export const detailCode = (max = 64) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/);
export const detailCount = () => z.number().int().min(0).max(100_000_000);
export const detailId = () => z.string().uuid();
/** Момент времени ISO-8601 */
export const detailIso = () => z.string().datetime({ offset: true });
/** Псевдоним `sa6m:` (HMAC платформенного ключа `audit`) — поиск по равенству без открытого значения */
export const detailHmac = () => z.string().max(128).regex(/^sa6m:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
/** Страна ISO 3166-1 alpha-2 */
export const detailCountry = () => z.string().regex(/^[A-Z]{2}$/);
export const detailDeviceClass = () => z.enum(AUDIT_DEVICE_CLASSES);
/**
 * Обоснование, введённое АДМИНОМ (причина команды Кабинета, пометка к отзыву ключа) —
 * единственный разрешённый текст в деталях (Google Access Transparency: justification).
 * Движок нормализует его при записи (NFKC, управляющие символы, секреты по образцу).
 */
export const detailNote = () => z.string().max(500);
/** Произвольный JSON снимка (вход/до/после команды Кабинета) — УЖЕ замаскированный продюсером; только платформе */
export const detailSnapshot = () => z.unknown();

/**
 * Запрещённые слова в ИМЕНАХ деталей: слова аналитики (ПДн и свободный текст) плюс
 * сетевые и секретные. IP живёт в своей зашифрованной колонке, секрет — нигде.
 * Единственный источник — страж `check:audit` читает этот массив из файла.
 */
export const AUDIT_DENY_DETAIL_WORDS = [
  'phone',
  'iin',
  'bin',
  'email',
  'name',
  'iban',
  'card',
  'token',
  'address',
  'text',
  'body',
  'title',
  'ip',
  'agent',
  'secret',
  'password',
  'otp',
  'code',
  'cookie',
  'authorization',
] as const;

/** Слова имени: `targetHmac` → target, hmac; `sessions_revoked` → sessions, revoked. */
export function auditDetailWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
}

export const AUDIT_LIMITS = {
  /** Блокировка входа: столько неудач подряд … */
  lockoutAttempts: 5,
  /** … за это окно (мин) счётчика неудач */
  lockoutWindowMin: 10,
  /** Первая блокировка (мин); каждая следующая подряд — вдвое дольше … */
  lockoutBaseMin: 15,
  lockoutFactor: 2,
  /** … но не дольше суток */
  lockoutMaxMin: 24 * 60,
  /** Новая сессия до подтверждения не может гасить чужой доступ (ч) */
  coolingHours: 24,
  /** Окно ленты человека (дни); `pd` и `consents` — без окна */
  personWindowDays: 365,
  /** Срок хранения в PostgreSQL (годы) — ЕТ № 832 п. 38: не менее 3 лет */
  retentionYears: 3,
  /** Интервал подписанных дайджестов (мин) */
  digestIntervalMin: 5,
  /** Потолок строк одной выгрузки организации */
  exportMaxRows: 100_000,
  /** Выгрузок журнала организацией в сутки */
  exportsPerDay: 5,
  /** Страница ленты */
  feedPageSize: 50,
  /** «Это не я» — стартов в час на человека */
  notMePerHour: 3,
  /** Заморозка без входа — стартов в час на IP */
  freezeStartsPerHour: 3,
  /** Отметка «видели» сессии/устройства — не чаще (мин) */
  lastSeenEveryMin: 5,
  /** Автозавершение неактивных сессий по умолчанию (дни) и допустимые значения */
  sessionMaxIdleDaysDefault: 90,
  sessionMaxIdleDaysOptions: [7, 30, 90, 180] as readonly number[],
  /** Устройство без активности столько дней — забывается */
  deviceForgetAfterDays: 365,
  /** Закрытая тревога живёт столько дней: очередь разбора, не журнал (факт — событие `detect.*`) */
  closedAlertRetentionDays: 365,
  /** Новизна клиента без X-Device-Id: ключ (ua_family, страна) живёт столько дней */
  unknownDeviceNoveltyDays: 30,
  /** Первые дни аккаунта: новое устройство — только уведомление, без тревоги */
  newAccountQuietDays: 7,
  /** Полей в деталях события */
  maxDetailKeys: 16,
  /** Строка в деталях */
  maxDetailString: 512,
  /** Потолок ключей реестра (страж предупреждает) */
  maxKeys: 200,
  /** Батч `pii.read`: сброс раз в … (мс) и не больше … строк */
  batchFlushMs: 1_000,
  batchMaxRows: 500,
  /** SMS «нет живого push-устройства» — не чаще раза в … (мин) на человека */
  smsAlertEveryMin: 60,
  /** Сессия без активности столько минут считается «живым push-устройством» не дольше */
  pushDeviceFreshDays: 30,
  /** Первый вход после стольких дней тишины — `detect.dormant_login` */
  dormantDays: 180,
  /** Запрос платформы: диапазон дат не шире (дни) */
  platformQueryMaxDays: 400,
  /**
   * Синхронный пересчёт в команде Кабинета (проверка дайджестов, повтор стрима в SIEM): окно не
   * шире (дни) — пересчёт идёт в запросе сотрудника, а не джобом; длинный период — несколько команд
   */
  platformScanMaxDays: 7,
} as const;

/** Заголовки клиентского контекста безопасности (api-client шлёт их на каждом запросе). */
export const AUDIT_HEADERS = {
  /** Устройство (uuid, постоянный на клиенте; НЕ зависит от отказа от аналитики) */
  device: 'X-Device-Id',
  /** Запрос (uuid на запрос; эхо в ответе и `details.requestId` конверта ошибки) */
  request: 'X-Request-Id',
} as const;

/** Машиночитаемые коды отказов движка (`details.code`). Текст — `errors.<code>`. */
export const AUDIT_ERROR_CODES = {
  eventNotFound: 'audit.event_not_found',
  notDisputable: 'audit.not_disputable',
  deviceNotFound: 'audit.device_not_found',
  sessionNotFound: 'audit.session_not_found',
  exportRange: 'audit.export_range',
  exportTooLarge: 'audit.export_too_large',
  exportDailyLimit: 'audit.export_daily_limit',
  rangeTooLong: 'audit.range_too_long',
  loginLocked: 'auth.locked',
  accountFrozen: 'auth.frozen',
  coolingPeriod: 'auth.cooling_period',
  currentSession: 'audit.current_session',
  alertNotFound: 'audit.alert_not_found',
  alertClosed: 'audit.alert_closed',
  notFrozen: 'audit.not_frozen',
  partitionNotFound: 'audit.partition_not_found',
} as const;

/** Причины завершения сессии (колонка `sessions.revoked_reason`, слова — `audit.revokeReasons.<code>`). */
export const SESSION_REVOKE_REASONS = [
  'self',
  'other_session',
  'logout_all',
  'password_change',
  'phone_change',
  'reset',
  'reuse',
  'not_me',
  'freeze',
  'admin',
  'platform',
  'inactive',
  'deleted',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/** Причины отказа входа (`reason_code` события `auth.login.failed`, слова — `audit.reasons.<code>`). */
export const AUTH_FAIL_REASONS = ['wrong_password', 'unknown_account', 'not_allowed', 'locked', 'frozen'] as const;
export type AuthFailReason = (typeof AUTH_FAIL_REASONS)[number];

/** Кто заморозил аккаунт (колонка `users.security_frozen_reason`). */
export const ACCOUNT_FREEZE_SOURCES = ['self', 'platform'] as const;
export type AccountFreezeSource = (typeof ACCOUNT_FREEZE_SOURCES)[number];

/** Источники выгрузок (`data.export{source}`) — каждая выгрузка = эксфильтрация, след обязателен. */
export const AUDIT_EXPORT_SOURCES = ['hr_zip', 'documents_zip', 'audit_org', 'audit_platform', 'my_data', 'analytics_report'] as const;
export type AuditExportSource = (typeof AUDIT_EXPORT_SOURCES)[number];

/** Форматы выгрузки журнала организацией. */
export const AUDIT_EXPORT_FORMATS = ['ndjson', 'csv'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** Виды тревог (`security_alerts.kind`) = ключи `detect.*` без префикса. */
export const AUDIT_ALERT_STATUSES = ['open', 'ack', 'closed'] as const;
export type AuditAlertStatus = (typeof AUDIT_ALERT_STATUSES)[number];

/** Итог закрытия тревоги (`security_alerts.resolution`, слова — `audit.alertResolutions.<code>`). */
export const AUDIT_ALERT_RESOLUTIONS = ['resolved', 'false_positive', 'accepted_risk', 'duplicate'] as const;
export type AuditAlertResolution = (typeof AUDIT_ALERT_RESOLUTIONS)[number];
