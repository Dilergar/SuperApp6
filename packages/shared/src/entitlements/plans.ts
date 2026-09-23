import type { EntitlementSubjectType, EntitlementValue } from './types';

// ============================================================
// Планы (тарифные ступени) — КЛЮЧИ в коде, значения в БД версиями
// ============================================================
// Ступени зафиксированы гриллом 2026-09-12: личные `free / personal / family`,
// организации `business_free / business_basic / business_standard / business_pro`.
// Подписок на отдельные сервисы НЕТ; add-on'ы — гранты источника `addon`.
// Названия для людей — каталог `entitlements.plans.<key>`; цен в продукте нет.

export const PLAN_KEYS = [
  'free',
  'personal',
  'family',
  'business_free',
  'business_basic',
  'business_standard',
  'business_pro',
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanDef {
  /** Тип субъекта, чьи подписки этот план принимает */
  subjectType: EntitlementSubjectType;
  /** Порядок ступени внутри своего субъекта (лестница «выше» = больше) */
  sortOrder: number;
  labelKey: string;
  /** Свободная ступень: живая подписка на неё не заводится (free = отсутствие строки) */
  free: boolean;
}

export const PLAN_DEFS: Record<PlanKey, PlanDef> = {
  free: { subjectType: 'user', sortOrder: 0, labelKey: 'entitlements.plans.free', free: true },
  personal: { subjectType: 'user', sortOrder: 10, labelKey: 'entitlements.plans.personal', free: false },
  family: { subjectType: 'family', sortOrder: 20, labelKey: 'entitlements.plans.family', free: false },
  business_free: { subjectType: 'workspace', sortOrder: 0, labelKey: 'entitlements.plans.business_free', free: true },
  business_basic: { subjectType: 'workspace', sortOrder: 10, labelKey: 'entitlements.plans.business_basic', free: false },
  business_standard: { subjectType: 'workspace', sortOrder: 20, labelKey: 'entitlements.plans.business_standard', free: false },
  business_pro: { subjectType: 'workspace', sortOrder: 30, labelKey: 'entitlements.plans.business_pro', free: false },
};

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLAN_DEFS, value);
}

/** Планы субъекта по возрастанию ступени. */
export function plansForSubject(subjectType: EntitlementSubjectType): PlanKey[] {
  return PLAN_KEYS.filter((k) => PLAN_DEFS[k].subjectType === subjectType).sort(
    (a, b) => PLAN_DEFS[a].sortOrder - PLAN_DEFS[b].sortOrder,
  );
}

/** Свободный план субъекта (значения — `defaultFree` реестра). */
export function freePlanOf(subjectType: EntitlementSubjectType): PlanKey | null {
  return plansForSubject(subjectType).find((k) => PLAN_DEFS[k].free) ?? null;
}

// ---- Триалы и льготный период (решения продукта) ----

/** Какой план получает субъект на пробу и на сколько дней. */
export const TRIAL_PLAN: Record<'user' | 'workspace', PlanKey> = {
  user: 'personal',
  workspace: 'business_pro',
};
export const TRIAL_DAYS = 30;
/** Неоплата: столько дней значения плана ещё действуют (с сигналом), потом — free. */
export const GRACE_DAYS = 15;

/** Статусы подписки. Free = ОТСУТСТВИЕ живой строки; живые — первые три. */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'expired', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

export const SUBSCRIPTION_SOURCES = ['trial', 'manual', 'migration', 'payment'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export const PLAN_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUSES)[number];

export const PLAN_STATUSES = ['active', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Регион тарифной сетки: сегодня один рынок; поле уже в данных, чтобы второй не требовал миграции. */
export const PLAN_REGION_DEFAULT = 'KZ';

export const ENTITLEMENT_GRANT_SOURCES = ['gift', 'trial', 'family', 'addon', 'manual', 'legacy'] as const;
export type EntitlementGrantSource = (typeof ENTITLEMENT_GRANT_SOURCES)[number];

export const ENTITLEMENT_OVERRIDE_MODES = ['set', 'unlimited', 'deny'] as const;
export type EntitlementOverrideMode = (typeof ENTITLEMENT_OVERRIDE_MODES)[number];

// ---- Сид первых версий (черновики по политике-множителю) ----

/**
 * Политика первого черновика платных ступеней (решение продукта): personal = free ×2;
 * бизнес: места 5 / 50 / 250, диск ×1 / ×5 / ×10; прочие числовые ключи организации
 * ×1 / ×2 / ×4. Свободные ступени несут ПУСТОЙ JSON — все значения из `defaultFree`.
 * Это черновик: кабинет правит и публикует его командой, в продукт значения не
 * попадают до публикации.
 */
export interface PlanSeedPolicy {
  /** Множитель для числовых ключей (ключ реестра → множитель; `*` — для остальных) */
  multipliers: Record<string, number>;
  /** Абсолютные значения, побеждающие множитель */
  absolute: Record<string, EntitlementValue>;
  /** Булевы фичи, включаемые ступенью */
  features: string[];
}

export const PLAN_SEED_POLICY: Record<PlanKey, PlanSeedPolicy | null> = {
  free: null,
  business_free: null,
  personal: { multipliers: { '*': 2 }, absolute: {}, features: ['skins.perGroup'] },
  family: { multipliers: { '*': 2 }, absolute: {}, features: ['skins.perGroup'] },
  // Журнал безопасности (core/audit): окно просмотра организацией — абсолютом (не множителем),
  // выгрузка — с basic, стрим в SIEM — со standard
  business_basic: {
    multipliers: { 'files.storageBytes': 1, '*': 1 },
    absolute: { 'workspace.seats': 5, 'audit.retentionDays': 180 },
    features: ['audit.export'],
  },
  business_standard: {
    multipliers: { 'files.storageBytes': 5, '*': 2 },
    absolute: { 'workspace.seats': 50, 'audit.retentionDays': 365 },
    features: ['audit.export', 'audit.stream'],
  },
  business_pro: {
    multipliers: { 'files.storageBytes': 10, '*': 4 },
    absolute: { 'workspace.seats': 250, 'audit.retentionDays': 1095 },
    features: ['audit.export', 'audit.stream'],
  },
};
