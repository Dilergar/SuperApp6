// ============================================================
// core/consents — реестр видов согласий (24-й движок)
// ============================================================
// Вид согласия = документ платформы, который принимает человек или организация.
// Реестр несёт ТОЛЬКО машинные признаки; короткие подписи (`consents.documents.<key>.title`)
// живут в каталоге i18n, а юридический ТЕКСТ — контент в БД (`ConsentVersion`), не каталог:
// версия обязана быть неизменяемой и подписанной, а каталог правится релизом.
//
// Движок обслуживает только отношения С ПЛАТФОРМОЙ. Согласие сотрудника работодателю —
// документ КЭДО; документы организаций для ИХ клиентов — будущий `scope: 'workspace'`.

/** Кто субъект приёмки: человек или организация (принимает владелец от её имени). */
export type ConsentSubjectType = 'user' | 'workspace';

/** Термины ЦК РК ст. 29: потребитель платформы и бизнес-пользователь. */
export type ConsentAudience = 'user' | 'business_user';

/**
 * Режим вида:
 *  - `opt_in`  — действует только после явного «принимаю» (молчание = нет);
 *  - `opt_out` — действует по умолчанию, человек вправе выключить (отказ тоже записывается);
 *  - `notice`  — уведомление: человек подтверждает, что ознакомлен; новая версия не блокирует.
 */
export type ConsentMode = 'opt_in' | 'opt_out' | 'notice';

/**
 * Шлюз новой СУЩЕСТВЕННОЙ версии после даты вступления в силу:
 *  - `block` — блокирующий экран у человека (`403 consents.pending`);
 *  - `soft`  — организация: закрыты только управленческие действия владельца, сотрудники работают;
 *  - `none`  — только уведомление.
 */
export type ConsentGate = 'block' | 'soft' | 'none';

export interface ConsentKindDef {
  subject: ConsentSubjectType;
  audience: ConsentAudience;
  /** Без живой приёмки субъект не существует (регистрация / создание организации) */
  required: boolean;
  /** Можно отозвать, не удаляя аккаунт. Отзыв `privacy` = удаление аккаунта (отдельная дверь) */
  revocable: boolean;
  mode: ConsentMode;
  gate: ConsentGate;
  /** Есть ли у вида текст-документ (версии в БД). `guardian` — крючок детских профилей без текста */
  hasDocument: boolean;
  /** Приёмка запрашивается в момент действия (подключение интеграции), а не на регистрации */
  onDemand?: boolean;
}

export function defineConsentKinds<const T extends Record<string, ConsentKindDef>>(defs: T): T {
  return defs;
}

export const CONSENT_KINDS = defineConsentKinds({
  // ---- B2C ----
  /** Пользовательское соглашение (оферта) */
  terms: { subject: 'user', audience: 'user', required: true, revocable: false, mode: 'opt_in', gate: 'block', hasDocument: true },
  /** Согласие на сбор и обработку ПДн (ЗоПД ст. 8 п. 4 — 8 реквизитов). Отзыв = удаление аккаунта */
  privacy: { subject: 'user', audience: 'user', required: true, revocable: false, mode: 'opt_in', gate: 'block', hasDocument: true },
  /** Трансграничная передача и перечень получателей — меняется чаще остальных, поэтому отдельно */
  cross_border: { subject: 'user', audience: 'user', required: true, revocable: false, mode: 'opt_in', gate: 'block', hasDocument: true },
  /** Политика оператора (ст. 25 п. 2 пп. 1-1) — уведомление, «ознакомлен» */
  privacy_policy: { subject: 'user', audience: 'user', required: true, revocable: false, mode: 'notice', gate: 'none', hasDocument: true },
  /** Рекламные и информационные рассылки — вторая галочка регистрации, не блокирует */
  marketing: { subject: 'user', audience: 'user', required: false, revocable: true, mode: 'opt_in', gate: 'none', hasDocument: true },
  /** Продуктовая аналитика: включена по умолчанию, выключается тумблером. Движок — правда, `User.analyticsOptOut` — зеркало */
  analytics: { subject: 'user', audience: 'user', required: false, revocable: true, mode: 'opt_out', gate: 'none', hasDocument: true },
  /** Подключение Google Calendar — трансграничная передача, не нужная для базовой работы: согласие в момент подключения */
  integration_google: { subject: 'user', audience: 'user', required: false, revocable: true, mode: 'opt_in', gate: 'none', hasDocument: true, onDemand: true },
  /** Согласие законного представителя за ребёнка — крючок будущих детских профилей (строится отдельно) */
  guardian: { subject: 'user', audience: 'user', required: false, revocable: true, mode: 'opt_in', gate: 'none', hasDocument: false },

  // ---- B2B ----
  /** Условия для организаций */
  business_terms: { subject: 'workspace', audience: 'business_user', required: true, revocable: false, mode: 'opt_in', gate: 'soft', hasDocument: true },
  /** Соглашение об обработке ПДн: организация — собственник, платформа — оператор по поручению */
  dpa: { subject: 'workspace', audience: 'business_user', required: true, revocable: false, mode: 'opt_in', gate: 'soft', hasDocument: true },
});

export type ConsentDocumentKey = keyof typeof CONSENT_KINDS;
export const CONSENT_DOCUMENT_KEYS = Object.keys(CONSENT_KINDS) as ConsentDocumentKey[];
/** Виды, у которых есть текст-документ (версии, публикация, витрина /legal) */
export const CONSENT_TEXT_DOCUMENT_KEYS = CONSENT_DOCUMENT_KEYS.filter((k) => CONSENT_KINDS[k].hasDocument);

export function isConsentDocumentKey(value: unknown): value is ConsentDocumentKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONSENT_KINDS, value);
}

export function consentKind(key: ConsentDocumentKey): ConsentKindDef {
  return CONSENT_KINDS[key];
}

/** Кто фактически нажал «принимаю»: сам человек, законный представитель, владелец организации. */
export const CONSENT_ACTOR_ROLES = ['self', 'guardian', 'org_owner'] as const;
export type ConsentActorRole = (typeof CONSENT_ACTOR_ROLES)[number];

/** Канал приёмки — часть доказательства (ЗоПД ст. 8 п. 1: «способом, позволяющим подтвердить получение»). */
export const CONSENT_CHANNELS = ['web', 'mobile', 'api', 'terminal'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** `withdrawn` — опубликована, но отозвана до вступления в силу новой публикацией того же документа */
export const CONSENT_VERSION_STATUSES = ['draft', 'published', 'superseded', 'withdrawn'] as const;
export type ConsentVersionStatus = (typeof CONSENT_VERSION_STATUSES)[number];

/** Причины отзыва (`ConsentAcceptance.revokedReason`). */
export const CONSENT_REVOKE_REASONS = ['user_revoked', 'declined', 'account_deleted', 'superseded', 'integration_disconnected', 'workspace_purged', 'not_me'] as const;
export type ConsentRevokeReason = (typeof CONSENT_REVOKE_REASONS)[number];

/** Возраст: регистрация с 16 (ГК ст. 22 — с оговоркой о согласии представителя), реальные деньги — с 18. */
export const CONSENT_AGE = {
  minRegistration: 16,
  adult: 18,
} as const;

export const CONSENT_LIMITS = {
  /** Публикация: дата вступления в силу по умолчанию, дней от публикации */
  defaultEffectiveInDays: 10,
  /** B2B: уведомление владельцу и админам минимум за N дней до вступления */
  workspaceNoticeDays: 30,
  /** Потолок длины тела документа на один язык, символов */
  bodyMax: 200_000,
  summaryMax: 6_000,
  changeSummaryMax: 4_000,
  urgentReasonMin: 20,
  /** Страница «Кому передавались мои данные» и история */
  pageSize: 50,
  /** Микрокэш глобальной эпохи согласий в процессе, мс (как у `keys:epoch`) */
  epochMicroCacheMs: 2_000,
  /** Кэш «что ждёт принятия» на человека, секунд (сбрасывается эпохами) */
  pendingCacheSec: 300,
  /** «Ждёт принятия»: сколько ЖИВЫХ организаций (свои — первыми) проверяется на человека */
  pendingWorkspacesMax: 100,
} as const;

export const CONSENT_REDIS = {
  /** Глобальная эпоха согласий: растёт при активации существенной версии */
  globalEpoch: 'consents:epoch',
  /** Кэш флага «у человека есть непринятые блокирующие документы»: `consents:gate:<userId>` */
  gate: (userId: string) => `consents:gate:${userId}`,
  /** Кэш мягкого шлюза организации: `consents:wsgate:<workspaceId>` */
  workspaceGate: (workspaceId: string) => `consents:wsgate:${workspaceId}`,
} as const;

export const CONSENT_ERROR_CODES = {
  /** Блокирующий шлюз: есть непринятые обязательные документы */
  pending: 'consents.pending',
  /** Мягкий шлюз организации: владелец не принял новые условия */
  workspacePending: 'consents.workspacePending',
  /** Действие требует согласий, а их не передали (регистрация, создание организации, интеграция) */
  required: 'consents.required',
  /** Клиент показал человеку не ту версию, что действует сейчас */
  versionMismatch: 'consents.versionMismatch',
  notRevocable: 'consents.notRevocable',
  notFound: 'consents.notFound',
  /** Подпись или хэш версии не сошлись — текст в базе подменён */
  integrity: 'consents.integrity',
  /** Правка опубликованной версии */
  immutable: 'consents.immutable',
  urgentNeedsReason: 'consents.urgentNeedsReason',
  effectiveInPast: 'consents.effectiveInPast',
  incompleteLocales: 'consents.incompleteLocales',
  minorNotAllowed: 'auth.minorNotAllowed',
  paymentsMinorNotAllowed: 'payments.minorNotAllowed',
} as const;
