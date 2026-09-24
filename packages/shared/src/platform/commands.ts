// ============================================================
// core/platform — константы исполнителя команд, сессии и лимитов кабинета
// ============================================================

/** Риск команды: тон в UI (low нейтральный · medium accent · high warning · critical danger) и гейты исполнителя. */
export const PLATFORM_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type PlatformRisk = (typeof PLATFORM_RISKS)[number];
export const PLATFORM_RISK_RANK: Record<PlatformRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Группы команд — вкладки/разделы в UI и фильтр журнала. */
export const PLATFORM_COMMAND_GROUPS = ['platform', 'entitlements', 'analytics', 'keys', 'consents', 'idempotency', 'security', 'lifecycle'] as const;
export type PlatformCommandGroup = (typeof PLATFORM_COMMAND_GROUPS)[number];

/** Исход записи аудита. */
export const PLATFORM_AUDIT_OUTCOMES = ['ok', 'denied', 'error'] as const;
export type PlatformAuditOutcome = (typeof PLATFORM_AUDIT_OUTCOMES)[number];

/** Виды записи журнала ЧТЕНИЙ (`PlatformAccessLog`). */
export const PLATFORM_ACCESS_KINDS = ['search', 'view', 'reveal'] as const;
export type PlatformAccessKind = (typeof PLATFORM_ACCESS_KINDS)[number];

/** Состояния заявки four-eyes. */
export const PLATFORM_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'executed', 'cancelled', 'failed'] as const;
export type PlatformRequestStatus = (typeof PLATFORM_REQUEST_STATUSES)[number];

/** Сущности карточки 360 и поиска. */
export const PLATFORM_ENTITIES = ['user', 'workspace'] as const;
export type PlatformEntity = (typeof PLATFORM_ENTITIES)[number];

export const PLATFORM_LIMITS = {
  /** Жизнь токена кабинета, часов (без refresh) */
  sessionHours: 8,
  /** Простой сессии, минут → 401 `platform.session_idle` */
  idleMinutes: 20,
  /** Окно sudo после step-up, минут (таймер сбрасывается высокорисковым действием) */
  sudoMinutes: 15,
  /** Неудачных паролей на входе до блокировки */
  loginFailMax: 5,
  /** Длительность блокировки входа, минут */
  loginBlockMinutes: 15,
  /** Причина у high/critical — не короче */
  reasonMinLength: 10,
  reasonMaxLength: 1000,
  /** Входы-списки id — не длиннее (S17) */
  maxListInput: 200,
  /** Поиск: текст не короче, совпадений не больше */
  searchMinChars: 3,
  lookupMaxHits: 20,
  /** Троттлинг на сотрудника (S10) */
  lookupPerMinute: 30,
  entityViewsPerMinute: 60,
  piiRevealsPerHour: 20,
  /** Серия отказов `denied` за час, после которой владельцам уходит security-alert */
  deniedAlertThreshold: 5,
  /** Страница журнала аудита */
  auditPageSize: 50,
} as const;

/**
 * Машиночитаемые коды отказов кабинета (`details.code`). Текст — `errors.platform.*`.
 */
export const PLATFORM_ERROR_CODES = {
  notStaff: 'platform.not_staff',
  sessionIdle: 'platform.session_idle',
  sessionRevoked: 'platform.session_revoked',
  stepUpRequired: 'platform.step_up_required',
  reasonRequired: 'platform.reason_required',
  idempotencyMismatch: 'platform.idempotency_mismatch',
  capabilityDenied: 'platform.capability_denied',
  selfTarget: 'platform.self_target',
  lastOwner: 'platform.last_owner',
  sodConflict: 'platform.sod_conflict',
  listTooLong: 'platform.list_too_long',
  workspaceHeaderRejected: 'platform.workspace_header_rejected',
  loginBlocked: 'platform.login_blocked',
  requestNotPending: 'platform.request_not_pending',
  authorCannotApprove: 'platform.author_cannot_approve',
  commandNotFound: 'platform.command_not_found',
  previewUnsupported: 'platform.preview_unsupported',
  rateLimited: 'platform.rate_limited',
  noApprover: 'platform.no_approver',
  /** Паспорт команды изменился между подачей заявки и её одобрением */
  commandVersionChanged: 'platform.command_version_changed',
} as const;
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES];

/** Ключ localStorage токена кабинета (отдельный от продуктового). */
export const PLATFORM_ACCESS_TOKEN_KEY = 'platformAccessToken';

/** Аудитория JWT кабинета — продуктовый гард такой токен отвергает. */
export const PLATFORM_JWT_AUDIENCE = 'platform';
