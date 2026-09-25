import { z } from 'zod';
import { LIFECYCLE_DATA_CLASSES } from '../lifecycle/types';
import { queryBoolean } from './query';

// Вход движка жизненного цикла (core/lifecycle): команды Кабинета, заморозки, квитанции стирания.

/** Окончательное удаление архивной организации (каскад реестра; «четыре глаза»). */
export const lifecycleWorkspacePurgeInputSchema = z.object({ workspaceId: z.string().uuid() }).strict();
export type LifecycleWorkspacePurgeInput = z.infer<typeof lifecycleWorkspacePurgeInputSchema>;

// ============================================================
// Заморозки (legal hold)
// ============================================================

/** Основание заморозки — код (подпись — `lifecycle.holds.reasons.<code>` в каталоге). */
export const LIFECYCLE_HOLD_REASONS = ['litigation', 'investigation', 'regulator_request', 'audit', 'other'] as const;
export type LifecycleHoldReason = (typeof LIFECYCLE_HOLD_REASONS)[number];

/**
 * Пространство заморозки: организация целиком или чат. Диск и Заметки держатся заморозкой
 * хранителя, записи или класса данных — пространство, которое движок не умеет проверить в
 * операторе удаления, не принимается (заморозка, которая ничего не держит, хуже отказа).
 */
export const LIFECYCLE_HOLD_SPACE_TYPES = ['workspace', 'chat'] as const;
export type LifecycleHoldSpaceType = (typeof LIFECYCLE_HOLD_SPACE_TYPES)[number];

export const LIFECYCLE_HOLD_SCOPE_KINDS = ['custodian', 'space', 'record', 'class'] as const;

/** Поля цели по области: у каждой области — ровно свои, чужие поля — ошибка. */
const HOLD_TARGET_FIELDS: Record<(typeof LIFECYCLE_HOLD_SCOPE_KINDS)[number], readonly string[]> = {
  custodian: ['custodianUserId'],
  space: ['spaceType', 'spaceId'],
  record: ['recordType', 'recordId'],
  class: ['dataClass'],
};
const ALL_TARGET_FIELDS = ['custodianUserId', 'spaceType', 'spaceId', 'recordType', 'recordId', 'dataClass'] as const;

const holdShape = {
  scope: z.enum(LIFECYCLE_HOLD_SCOPE_KINDS),
  custodianUserId: z.string().uuid().optional(),
  spaceType: z.enum(LIFECYCLE_HOLD_SPACE_TYPES).optional(),
  spaceId: z.string().uuid().optional(),
  /** id политики реестра (модель Prisma) */
  recordType: z.string().regex(/^[A-Z][A-Za-z0-9]{1,63}$/).optional(),
  recordId: z.string().uuid().optional(),
  dataClass: z.enum(LIFECYCLE_DATA_CLASSES).optional(),
  reasonCode: z.enum(LIFECYCLE_HOLD_REASONS),
  /** Обоснование администратора — видят админы организации и платформа, хранителю не показывается */
  note: z.string().trim().max(500).optional(),
};

function refineHoldTarget(v: Partial<Record<(typeof ALL_TARGET_FIELDS)[number], unknown>> & { scope: (typeof LIFECYCLE_HOLD_SCOPE_KINDS)[number] }, ctx: z.RefinementCtx): void {
  const own = HOLD_TARGET_FIELDS[v.scope];
  for (const f of ALL_TARGET_FIELDS) {
    const present = v[f] !== undefined && v[f] !== null;
    if (own.includes(f) && !present) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'validation.lifecycle.holdTargetRequired' });
    if (!own.includes(f) && present) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'validation.lifecycle.holdTargetForeign' });
  }
}

/** Постановка заморозки организацией (организация — из адреса): область и её цель. */
export const lifecycleHoldCreateSchema = z.object(holdShape).strict().superRefine(refineHoldTarget);
export type LifecycleHoldCreateInput = z.infer<typeof lifecycleHoldCreateSchema>;

export const lifecycleHoldReleaseSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
export type LifecycleHoldReleaseInput = z.infer<typeof lifecycleHoldReleaseSchema>;

export const lifecycleHoldsQuerySchema = z
  .object({
    /** true — только действующие */
    active: queryBoolean.optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type LifecycleHoldsQuery = z.infer<typeof lifecycleHoldsQuerySchema>;

/**
 * Команды Кабинета: заморозка платформы (`workspaceId` пуст — держит данные всех организаций и
 * личное человека) или от имени организации; снятие любой заморозки.
 */
export const lifecyclePlatformHoldCreateSchema = z
  .object({ ...holdShape, workspaceId: z.string().uuid().nullable().optional() })
  .strict()
  .superRefine(refineHoldTarget);
export type LifecyclePlatformHoldCreateInput = z.infer<typeof lifecyclePlatformHoldCreateSchema>;
export const lifecyclePlatformHoldReleaseSchema = z.object({ holdId: z.string().uuid(), note: z.string().trim().max(500).optional() }).strict();
export type LifecyclePlatformHoldReleaseInput = z.infer<typeof lifecyclePlatformHoldReleaseSchema>;

/** Заморозка на проводе (организация видит свои, Кабинет — все). */
export interface LifecycleHoldDto {
  id: string;
  scope: 'custodian' | 'space' | 'record' | 'class';
  workspaceId: string | null;
  custodianUserId: string | null;
  spaceType: string | null;
  spaceId: string | null;
  recordType: string | null;
  recordId: string | null;
  dataClass: string | null;
  reasonCode: LifecycleHoldReason;
  note: string | null;
  createdById: string;
  createdAt: string;
  releasedAt: string | null;
  releasedById: string | null;
  releaseNote: string | null;
}

// ============================================================
// Стирание: квитанция и сертификат
// ============================================================

/**
 * Код квитанции стирания — 26 знаков base32 (128 бит случайности). Человек получает его в
 * мастере удаления: аккаунта после стирания нет, и страница `/legal/erasure/<код>` — его
 * единственный путь к сертификату. В базе — только sha256 кода.
 */
export const LIFECYCLE_RECEIPT_RE = /^[a-z2-7]{26}$/;
export const lifecycleErasureReceiptParamSchema = z.object({ code: z.string().regex(LIFECYCLE_RECEIPT_RE) }).strict();

/** Этапы стирания в порядке прохождения (квитанция показывает пройденные с датами). */
export const LIFECYCLE_ERASURE_STATUSES = ['scheduled', 'held', 'running', 'hot_purged', 'keys_destroyed', 'completed', 'cancelled', 'failed'] as const;
export type LifecycleErasureStatus = (typeof LIFECYCLE_ERASURE_STATUSES)[number];

/**
 * Сертификат стирания (NIST 800-88 «certificate of sanitization»): без ПДн — псевдоним
 * субъекта, версии политик, счётчики по классам данных, id уничтоженных ключей, моменты.
 * Подписан Ed25519 (аудитория `lifecycle` движка ключей), проверяется по JWKS.
 */
export interface LifecycleErasureCertificate {
  v: 1;
  subjectType: 'user' | 'workspace';
  /** HMAC платформенного ключа от субъекта — не обращается в личность без базы */
  pseudonym: string;
  requestedAt: string;
  effectiveAt: string;
  hiddenAt: string | null;
  hotPurgedAt: string | null;
  keysDestroyedAt: string | null;
  backupsClearAt: string | null;
  completedAt: string;
  /** Класс данных → строк стёрто */
  counts: Record<string, number>;
  /** Политика → версия реестра на момент стирания */
  policies: Record<string, number>;
  /** Уничтоженные ключи (id ключей keystore, без материала) */
  keyIds: string[];
}

/**
 * Подписываемые байты сертификата: канонический JSON (ключи по алфавиту на всех уровнях).
 * Одна функция для сервера и страницы проверки — иначе подпись «не сходится» из-за порядка.
 */
export function lifecycleCertificatePayload(cert: LifecycleErasureCertificate): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(canon(cert));
}

/** Публичная квитанция: этапы, даты и — после завершения — подписанный сертификат. Без ПДн. */
export interface LifecycleErasureReceiptDto {
  subjectType: 'user' | 'workspace';
  status: LifecycleErasureStatus;
  requestedAt: string;
  effectiveAt: string;
  hiddenAt: string | null;
  hotPurgedAt: string | null;
  keysDestroyedAt: string | null;
  backupsClearAt: string | null;
  completedAt: string | null;
  certificate: LifecycleErasureCertificate | null;
  /** base64url Ed25519 над `lifecycleCertificatePayload(certificate)` */
  signature: string | null;
  kid: string | null;
}

// ============================================================
// Канарейка стирания (ночная проверка, дев-полигон, дашборд Кабинета)
// ============================================================

/**
 * Вид находки канарейки:
 *  - `present` — личная посеянная строка пережила стирание;
 *  - `missing` — общая строка или строка организации исчезла при стирании человека (лишнее удаление);
 *  - `name` — имя стёртого осталось в строке, которая по праву осталась (снимок не псевдонимизирован);
 *  - `marker` — томбстоун сохранил текст;
 *  - `owned` — у стёртого остались личные строки политики `hard_delete` (не посеянные — утечка пути);
 *  - `redis` — ключи с его id в семействе с шаблоном субъекта;
 *  - `blob` — байты посеянного объекта живы;
 *  - `keys` — ключи его скоупа не поставлены на уничтожение;
 *  - `tenant` — после purge-каскада организации остались её строки;
 *  - `seed` — посев модуля упал (хранилище не проверено);
 *  - `error` — прогон сорвался.
 */
export const LIFECYCLE_CANARY_FINDING_KINDS = ['present', 'missing', 'name', 'marker', 'owned', 'redis', 'blob', 'keys', 'tenant', 'seed', 'error'] as const;
export type LifecycleCanaryFindingKind = (typeof LIFECYCLE_CANARY_FINDING_KINDS)[number];

export interface LifecycleCanaryFinding {
  /** Хранилище: id политики реестра, ключ посева или `canary` */
  store: string;
  kind: LifecycleCanaryFindingKind;
  count: number;
}

/** Отчёт прогона канарейки (без ПДн: синтетические субъекты, коды и счётчики). */
export interface LifecycleCanaryReportDto {
  runId: string;
  ok: boolean;
  /** Посеяно строк и различных политик */
  planted: number;
  policies: number;
  /** Политики плана стирания без посева — хранилища, которые канарейка не проверила */
  unseeded: string[];
  findings: LifecycleCanaryFinding[];
  /** Политики, чью проверку остановил потолок времени запроса (не находка — пробел) */
  skipped: string[];
  durationMs: number;
  /** Синтетические субъекты убраны (иначе доберёт следующий прогон) */
  cleaned: boolean;
}

/** Утечка для проверки самой канарейки (дев-полигон): строка или ключ стёртого ПОСЛЕ стирания. */
export const LIFECYCLE_CANARY_LEAKS = ['row', 'redis'] as const;
export type LifecycleCanaryLeak = (typeof LIFECYCLE_CANARY_LEAKS)[number];
export const lifecycleCanaryRunSchema = z.object({ leak: z.enum(LIFECYCLE_CANARY_LEAKS).optional() }).strict();
export type LifecycleCanaryRunInput = z.infer<typeof lifecycleCanaryRunSchema>;

/**
 * Часть выгрузки в `lifecycle_exports.parts` (пишет сборщик выгрузки, читают стирание, срок и
 * каскад организации): объект под изолированным префиксом `exports/<exportId>/`, размер, sha256.
 * Манифест — `exports/<exportId>/manifest.json`.
 */
export interface LifecycleExportPart {
  key: string;
  bytes: number;
  sha256: string;
}
export const LIFECYCLE_EXPORT_PREFIX = 'exports/';

/**
 * Серверная (архивная) проверка подписи сертификата по квитанции: работает и после ротации —
 * выведенного ключа в JWKS уже нет, а открытая часть версии хранится. `pending` — сертификата
 * ещё нет (окно бэкапов не прошло).
 */
export interface LifecycleErasureVerificationDto {
  state: 'valid' | 'invalid' | 'pending';
  kid: string | null;
  checkedAt: string;
}
