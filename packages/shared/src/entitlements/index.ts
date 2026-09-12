// ============================================================
// core/entitlements — единый реестр ключей (сливается из файлов сервисов)
// ============================================================
// Новый ключ = строка в файле своего сервиса (+ файл, если сервиса ещё нет) +
// `entitlements.keys.<id>` в трёх каталогах + провайдер расхода в API (для
// `hasUsage`). Union `EntitlementKey` ВЫВОДИТСЯ из реестра, руками не пишется.

import {
  ENTITLEMENT_SERVICES,
  defaultFreeFor,
  mergeOfKind,
  type EntitlementDef,
  type EntitlementServiceKey,
  type EntitlementSubjectType,
  type EntitlementValue,
} from './types';
import { WORKSPACES_ENTITLEMENTS } from './workspaces';
import { FILES_ENTITLEMENTS } from './files';
import { CONTACTS_ENTITLEMENTS } from './contacts';
import { SHOP_ENTITLEMENTS } from './shop';
import { OBJECTS_ENTITLEMENTS } from './objects';
import { LEGAL_ENTITIES_ENTITLEMENTS } from './legal-entities';
import { CARD_SKINS_ENTITLEMENTS } from './card-skins';
import { NOTIFICATIONS_ENTITLEMENTS } from './notifications';
import { PLAN_DEFS, PLAN_KEYS, PLAN_SEED_POLICY, type PlanKey } from './plans';

export * from './types';
export * from './plans';

const REGISTRY_RAW = {
  ...WORKSPACES_ENTITLEMENTS,
  ...FILES_ENTITLEMENTS,
  ...CONTACTS_ENTITLEMENTS,
  ...SHOP_ENTITLEMENTS,
  ...OBJECTS_ENTITLEMENTS,
  ...LEGAL_ENTITIES_ENTITLEMENTS,
  ...CARD_SKINS_ENTITLEMENTS,
  ...NOTIFICATIONS_ENTITLEMENTS,
} as const satisfies Record<string, EntitlementDef>;

/** Union ключей — выводится из реестра. */
export type EntitlementKey = keyof typeof REGISTRY_RAW;

/** Реестр с единой формой декларации на каждом ключе. */
export const ENTITLEMENT_REGISTRY: Readonly<Record<EntitlementKey, EntitlementDef>> = REGISTRY_RAW;

export const ENTITLEMENT_KEYS = Object.keys(ENTITLEMENT_REGISTRY) as EntitlementKey[];

export function isEntitlementKey(value: unknown): value is EntitlementKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENTITLEMENT_REGISTRY, value);
}

/** Декларация ключа; для строки прошлой версии (ключ ушёл из реестра) — undefined. */
export function entitlementDef(key: string): EntitlementDef | undefined {
  return isEntitlementKey(key) ? ENTITLEMENT_REGISTRY[key] : undefined;
}

/** Ключи, имеющие смысл у субъекта данного типа (в порядке сервисов реестра). */
export function entitlementKeysFor(subjectType: EntitlementSubjectType): EntitlementKey[] {
  return ENTITLEMENT_KEYS.filter((k) => ENTITLEMENT_REGISTRY[k].subjects.includes(subjectType)).sort(
    (a, b) => ENTITLEMENT_SERVICES[ENTITLEMENT_REGISTRY[a].service].order - ENTITLEMENT_SERVICES[ENTITLEMENT_REGISTRY[b].service].order,
  );
}

/** Ключи сервиса в порядке реестра. */
export function entitlementKeysOf(service: EntitlementServiceKey): EntitlementKey[] {
  return ENTITLEMENT_KEYS.filter((k) => ENTITLEMENT_REGISTRY[k].service === service);
}

/** Свободные значения субъекта — база резолва и «как было до движка». */
export function freeValuesFor(subjectType: EntitlementSubjectType): Record<EntitlementKey, EntitlementValue> {
  const out = {} as Record<EntitlementKey, EntitlementValue>;
  for (const key of entitlementKeysFor(subjectType)) out[key] = defaultFreeFor(ENTITLEMENT_REGISTRY[key], subjectType);
  return out;
}

/**
 * Первый черновик версии плана по политике-множителю (см. `PLAN_SEED_POLICY`).
 * Свободные ступени — пустой JSON.
 */
export function seedPlanVersionValues(plan: PlanKey): Partial<Record<EntitlementKey, EntitlementValue>> {
  const policy = PLAN_SEED_POLICY[plan];
  if (!policy) return {};
  const subjectType = PLAN_DEFS[plan].subjectType;
  const out: Partial<Record<EntitlementKey, EntitlementValue>> = {};
  for (const key of entitlementKeysFor(subjectType)) {
    const def = ENTITLEMENT_REGISTRY[key];
    if (def.kind === 'feature') {
      if (policy.features.includes(key)) out[key] = true;
      continue;
    }
    if (key in policy.absolute) {
      out[key] = policy.absolute[key] as EntitlementValue;
      continue;
    }
    const base = defaultFreeFor(def, subjectType);
    if (typeof base !== 'number') continue;
    const mult = policy.multipliers[key] ?? policy.multipliers['*'] ?? 1;
    out[key] = Math.round(base * mult);
  }
  return out;
}

/** Правило слияния для ключа. */
export function mergeOf(key: EntitlementKey) {
  const def = ENTITLEMENT_REGISTRY[key];
  return def.merge ?? mergeOfKind(def.kind);
}

/** Сравнение значений: «b даёт больше, чем a» (для поиска ступени разблокировки). */
export function entitlementGreater(a: EntitlementValue, b: EntitlementValue): boolean {
  if (b === null) return a !== null;
  if (a === null) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return b === true && a !== true;
  return b > a;
}

export const ALL_PLAN_KEYS: readonly PlanKey[] = PLAN_KEYS;

/**
 * Машиночитаемые коды отказа 402 (`details.code`). Клиент ветвится по ним, а не по
 * тексту; фраза — `errors.entitlement.<code>` в каталоге.
 */
export const ENTITLEMENT_ERROR_CODES = {
  featureLocked: 'entitlement.feature_locked',
  limitReached: 'entitlement.limit_reached',
  quotaExhausted: 'entitlement.quota_exhausted',
  planExpired: 'entitlement.plan_expired',
  seatRequired: 'entitlement.seat_required',
  /**
   * Ключа у субъекта этого вида НЕТ (личный ключ спросили в контексте организации
   * или наоборот). Не «нельзя по тарифу», а неверный вопрос: отсутствие ключа НЕ
   * значит «без ограничения», и клиент не вправе прочитать это как «можно».
   */
  keyNotForSubject: 'entitlement.key_not_for_subject',
} as const;
export type EntitlementErrorCode = (typeof ENTITLEMENT_ERROR_CODES)[keyof typeof ENTITLEMENT_ERROR_CODES];

/** Кто может разблокировать: сам человек (личный тариф) или владелец организации. */
export type EntitlementUnlockBy = 'self' | 'workspace_owner';
