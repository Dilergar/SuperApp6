import type {
  EntitlementCarrier,
  EntitlementErrorCode,
  EntitlementGrantSource,
  EntitlementKey,
  EntitlementKind,
  EntitlementOverrideMode,
  EntitlementPeriod,
  EntitlementSubjectType,
  EntitlementUnit,
  EntitlementUnlockBy,
  EntitlementValue,
  PlanKey,
  PlanStatus,
  PlanVersionStatus,
  SubscriptionSource,
  SubscriptionStatus,
} from '../entitlements';

// ============================================================
// core/entitlements — формы провода (обе стороны: API ↔ веб/mobile/кабинет)
// ============================================================

export interface EntitlementSubjectRef {
  type: EntitlementSubjectType;
  id: string;
}

/** Откуда пришло итоговое значение. В продукт уезжает ТОЛЬКО тип источника и срок. */
export type EntitlementSource = 'default' | 'plan' | 'grant' | 'override';

export interface EntitlementUnlockDto {
  by: EntitlementUnlockBy;
  /** Ближайшая ступень, где значение больше (по опубликованным версиям); null — нет такой */
  plan: PlanKey | null;
}

/** Одно значение снимка. Продукту НЕ уезжают `reason`, `grantedBy`, `createdBy` источников. */
export interface EntitlementValueDto {
  key: EntitlementKey;
  kind: EntitlementKind;
  carrier: EntitlementCarrier;
  unit: EntitlementUnit | null;
  period: EntitlementPeriod | null;
  value: EntitlementValue;
  /** Расход: quota — потрачено за период; limit с провайдером — живых сущностей; иначе null */
  used: number | null;
  /** Конец периода квоты (сброс) */
  resetAt: string | null;
  source: EntitlementSource;
  /** Подтип источника, публичный: источник гранта (`gift`…) либо режим оверрайда */
  sourceKind: EntitlementGrantSource | EntitlementOverrideMode | null;
  /** Срок гранта/оверрайда (null — бессрочно или значение из плана/дефолта) */
  sourceUntil: string | null;
  unlock: EntitlementUnlockDto;
}

/** Подписка глазами клиента продукта — без внутренних полей (createdBy, source). */
export interface SubscriptionSummaryDto {
  planKey: PlanKey;
  planLabelKey: string;
  version: number;
  status: SubscriptionStatus;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  /** Ближайший срок, после которого значения изменятся (min сроков) */
  expiresAt: string | null;
}

/**
 * Снимок контекста: person-ключи — из субъекта `user`, container-ключи — из субъекта
 * контекста (личное пространство = сам человек; организация — из ALS `X-Workspace-Id`).
 */
export interface EntitlementSnapshotDto {
  contextType: 'user' | 'workspace';
  contextId: string;
  /** Подписка контейнера контекста (null = free) */
  subscription: SubscriptionSummaryDto | null;
  /** При контексте организации — личная подписка человека (носитель person-ключей) */
  personalSubscription: SubscriptionSummaryDto | null;
  /** Живой подписки нет, но недавно (≤ 30 дней) была — чип «тариф истёк» вместо «бесплатный» */
  recentlyEnded: { planKey: PlanKey; planLabelKey: string; status: SubscriptionStatus; endedAt: string } | null;
  values: Partial<Record<EntitlementKey, EntitlementValueDto>>;
  /** Когда снимок перестанет быть верным (ближайший срок любого источника) */
  expiresAt: string | null;
  computedAt: string;
}

// ---- Батч-проверка (AI-инструменты, клиенты) ----

export interface EntitlementCheckItemDto {
  key: EntitlementKey;
  /** Сколько хотим добавить (limit/quota); по умолчанию 1 */
  delta?: number;
}

export interface EntitlementCheckResultDto {
  key: EntitlementKey;
  allowed: boolean;
  value: EntitlementValue;
  used: number | null;
  remaining: number | null;
  code: EntitlementErrorCode | null;
  unlock: EntitlementUnlockDto;
}

export interface EntitlementCheckResponseDto {
  contextType: 'user' | 'workspace';
  contextId: string;
  results: EntitlementCheckResultDto[];
}

// ---- Каталог и субъекты (кабинет платформы; полные поля) ----

export interface PlanVersionDto {
  id: string;
  planId: string;
  planKey: PlanKey;
  version: number;
  status: PlanVersionStatus;
  region: string;
  entitlements: Partial<Record<EntitlementKey, EntitlementValue>>;
  note: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDto {
  id: string;
  key: PlanKey;
  subjectType: EntitlementSubjectType;
  status: PlanStatus;
  sortOrder: number;
  labelKey: string;
  versions: PlanVersionDto[];
}

export interface EntitlementCatalogDto {
  plans: PlanDto[];
  /** Свободные значения по субъектам — колонка «free» рядом со ступенями */
  freeValues: Record<EntitlementSubjectType, Partial<Record<EntitlementKey, EntitlementValue>>>;
}

export interface SubjectSubscriptionDto {
  id: string;
  subjectType: EntitlementSubjectType;
  subjectId: string;
  planKey: PlanKey;
  planVersionId: string;
  version: number;
  status: SubscriptionStatus;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelledAt: string | null;
  source: SubscriptionSource;
  trialConsumedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntitlementGrantDto {
  id: string;
  subjectType: EntitlementSubjectType;
  subjectId: string;
  key: string;
  value: EntitlementValue;
  source: EntitlementGrantSource;
  priority: number;
  effectiveFrom: string;
  validUntil: string | null;
  reason: string | null;
  grantedBy: string | null;
  idempotencyKey: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface EntitlementOverrideDto {
  id: string;
  subjectType: EntitlementSubjectType;
  subjectId: string;
  key: string;
  mode: EntitlementOverrideMode;
  value: EntitlementValue;
  reason: string;
  validUntil: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuotaCounterDto {
  subjectType: EntitlementSubjectType;
  subjectId: string;
  key: string;
  used: number;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string;
}

/** Карточка субъекта в кабинете: всё, что движок про него знает + итоговый снимок. */
export interface EntitlementSubjectDetailDto {
  subject: EntitlementSubjectRef;
  subscription: SubjectSubscriptionDto | null;
  history: SubjectSubscriptionDto[];
  grants: EntitlementGrantDto[];
  overrides: EntitlementOverrideDto[];
  counters: QuotaCounterDto[];
  /** Итог глазами субъекта (для организации — container-ключи; person-ключи у человека) */
  snapshot: EntitlementSnapshotDto;
}
