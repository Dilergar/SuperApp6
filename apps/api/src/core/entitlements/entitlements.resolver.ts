import {
  ENTITLEMENT_REGISTRY,
  defaultFreeFor,
  entitlementKeysFor,
  mergeOf,
  type EntitlementGrantSource,
  type EntitlementKey,
  type EntitlementOverrideMode,
  type EntitlementSource,
  type EntitlementSubjectType,
  type EntitlementValue,
} from '@superapp/shared';

// ============================================================
// Чистая функция слияния источников в итоговые значения субъекта.
// Лестница: defaultFree → значения версии плана → гранты (по правилу вида ключа)
// → оверрайд (последним). Без обращений к БД и без побочных эффектов — её можно
// проверить таблицей входов.
// ============================================================

export interface ResolverGrant {
  key: string;
  value: EntitlementValue;
  source: EntitlementGrantSource;
  priority: number;
  validUntil: Date | null;
}

export interface ResolverOverride {
  key: string;
  mode: EntitlementOverrideMode;
  value: EntitlementValue;
  validUntil: Date;
}

export interface ResolvedValue {
  value: EntitlementValue;
  source: EntitlementSource;
  sourceKind: EntitlementGrantSource | EntitlementOverrideMode | null;
  sourceUntil: Date | null;
}

export interface ResolveInput {
  subjectType: EntitlementSubjectType;
  /** Значения версии плана живой подписки; null — подписки нет (free) */
  planValues: Partial<Record<string, EntitlementValue>> | null;
  /** Гранты уже отфильтрованы по окну действия и отзыву */
  grants: ResolverGrant[];
  /** Оверрайды уже отфильтрованы по сроку */
  overrides: ResolverOverride[];
  /** Ближайший срок подписки (trialEndsAt / currentPeriodEnd / graceUntil) */
  subscriptionEndsAt: Date | null;
}

export interface ResolveOutput {
  values: Record<EntitlementKey, ResolvedValue>;
  /** Ближайший момент, когда любой источник перестанет действовать */
  expiresAt: Date | null;
}

const minDate = (a: Date | null, b: Date | null): Date | null => {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
};

export function resolveSubjectValues(input: ResolveInput): ResolveOutput {
  const values = {} as Record<EntitlementKey, ResolvedValue>;
  let expiresAt: Date | null = input.subscriptionEndsAt;

  const grantsByKey = new Map<string, ResolverGrant[]>();
  for (const g of input.grants) {
    const list = grantsByKey.get(g.key) ?? [];
    list.push(g);
    grantsByKey.set(g.key, list);
    expiresAt = minDate(expiresAt, g.validUntil);
  }
  const overrideByKey = new Map<string, ResolverOverride>();
  for (const o of input.overrides) {
    overrideByKey.set(o.key, o);
    expiresAt = minDate(expiresAt, o.validUntil);
  }

  for (const key of entitlementKeysFor(input.subjectType)) {
    const def = ENTITLEMENT_REGISTRY[key];
    const free = defaultFreeFor(def, input.subjectType);
    let resolved: ResolvedValue;
    const fromPlan = input.planValues && key in input.planValues ? input.planValues[key] : undefined;
    if (fromPlan !== undefined) {
      resolved = { value: fromPlan as EntitlementValue, source: 'plan', sourceKind: null, sourceUntil: input.subscriptionEndsAt };
    } else {
      resolved = { value: free, source: 'default', sourceKind: null, sourceUntil: null };
    }

    const grants = grantsByKey.get(key);
    if (grants?.length) resolved = mergeGrants(key, resolved, grants);

    const override = overrideByKey.get(key);
    if (override) resolved = applyOverride(key, override);

    values[key] = resolved;
  }

  return { values, expiresAt };
}

function mergeGrants(key: EntitlementKey, base: ResolvedValue, grants: ResolverGrant[]): ResolvedValue {
  const rule = mergeOf(key);
  switch (rule) {
    case 'or': {
      const winners = grants.filter((g) => g.value === true);
      if (base.value === true || !winners.length) return base;
      // Срок — самый дальний среди включающих грантов (бессрочный побеждает)
      const until = winners.some((g) => !g.validUntil)
        ? null
        : winners.reduce<Date | null>((m, g) => (!m || (g.validUntil && g.validUntil > m) ? g.validUntil : m), null);
      const top = winners.sort((a, b) => b.priority - a.priority)[0];
      return { value: true, source: 'grant', sourceKind: top.source, sourceUntil: until };
    }
    case 'max': {
      if (base.value === null) return base; // без ограничения — больше некуда
      let best = base;
      for (const g of grants) {
        if (g.value === null) return { value: null, source: 'grant', sourceKind: g.source, sourceUntil: g.validUntil };
        if (typeof g.value === 'number' && typeof best.value === 'number' && g.value > best.value) {
          best = { value: g.value, source: 'grant', sourceKind: g.source, sourceUntil: g.validUntil };
        }
      }
      return best;
    }
    case 'sum': {
      if (base.value === null) return base;
      let total = typeof base.value === 'number' ? base.value : 0;
      let until: Date | null = null;
      let kind: EntitlementGrantSource | null = null;
      let added = false;
      for (const g of grants) {
        if (g.value === null) return { value: null, source: 'grant', sourceKind: g.source, sourceUntil: g.validUntil };
        if (typeof g.value !== 'number' || g.value <= 0) continue;
        total += g.value;
        added = true;
        kind = kind ?? g.source;
        // Ближайший срок среди слагаемых: после него сумма уменьшится
        if (g.validUntil && (!until || g.validUntil < until)) until = g.validUntil;
      }
      return added ? { value: total, source: 'grant', sourceKind: kind, sourceUntil: until } : base;
    }
    default: {
      const top = [...grants].sort((a, b) => b.priority - a.priority)[0];
      return { value: top.value, source: 'grant', sourceKind: top.source, sourceUntil: top.validUntil };
    }
  }
}

function applyOverride(key: EntitlementKey, o: ResolverOverride): ResolvedValue {
  const def = ENTITLEMENT_REGISTRY[key];
  const feature = def.kind === 'feature';
  switch (o.mode) {
    case 'unlimited':
      return { value: feature ? true : null, source: 'override', sourceKind: 'unlimited', sourceUntil: o.validUntil };
    case 'deny':
      return { value: feature ? false : 0, source: 'override', sourceKind: 'deny', sourceUntil: o.validUntil };
    default:
      return { value: o.value, source: 'override', sourceKind: 'set', sourceUntil: o.validUntil };
  }
}
