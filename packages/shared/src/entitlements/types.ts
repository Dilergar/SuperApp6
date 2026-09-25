// ============================================================
// core/entitlements (19-й платформенный движок) — словарь реестра КЛЮЧЕЙ
// ============================================================
// Ключ — ДЕКЛАРИРУЕМАЯ сущность «что человек или организация может и сколько»
// (Stigg/Schematic feature, Salesforce TenantUsageEntitlement), а не константа в
// коде. Реестр называет СМЫСЛ ключа: вид, носитель, субъекты, единицу, свободное
// значение. СЛОВА живут в каталоге `@superapp/i18n` (`entitlements.keys.<id>`).
//
// Правило миграции: ключ, переехавший сюда, УДАЛЯЕТСЯ из `*_LIMITS` (не
// дублируется) — забытый читатель не компилируется, и второго источника правды
// у тарифной сетки нет.

/**
 * Вид ключа определяет слияние источников и форму значения:
 * - feature — булево «доступно/нет» (OR грантов);
 * - limit   — потолок количества живых сущностей (MAX; usage считает провайдер);
 * - quota   — расходуемый объём за период или навсегда (SUM грантов; счётчик в БД);
 * - config  — настройка-число без потолка (ранг: побеждает источник старше).
 */
export const ENTITLEMENT_KINDS = ['feature', 'limit', 'quota', 'config'] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

/**
 * Носитель ключа (решение продукта, грилл 2026-09-12):
 * - container — ценность живёт в контейнере контекста (личное пространство или
 *   организация) и НЕ протекает между личным и рабочим;
 * - person — едет с человеком во все контексты (косметика: скины карточек).
 */
export const ENTITLEMENT_CARRIERS = ['container', 'person'] as const;
export type EntitlementCarrier = (typeof ENTITLEMENT_CARRIERS)[number];

/** Кто бывает субъектом подписки/гранта. `family` зарезервирован (без UI). */
export const ENTITLEMENT_SUBJECT_TYPES = ['user', 'workspace', 'family'] as const;
export type EntitlementSubjectType = (typeof ENTITLEMENT_SUBJECT_TYPES)[number];

/** Правило слияния грантов одного ключа (по умолчанию — из вида). */
export const ENTITLEMENT_MERGES = ['or', 'max', 'sum', 'rank'] as const;
export type EntitlementMerge = (typeof ENTITLEMENT_MERGES)[number];

export const ENTITLEMENT_UNITS = ['bytes', 'count'] as const;
export type EntitlementUnit = (typeof ENTITLEMENT_UNITS)[number];

/** Период квоты; отсутствует — квота «навсегда» (место на Диске). */
export const ENTITLEMENT_PERIODS = ['day', 'month'] as const;
export type EntitlementPeriod = (typeof ENTITLEMENT_PERIODS)[number];

/**
 * Значение ключа на проводе и в JSON версии плана. `null` у limit/quota = БЕЗ
 * ограничения. У feature — boolean, у limit/quota/config — number | null.
 */
export type EntitlementValue = number | boolean | null;

/**
 * Свободное значение — одно на все субъекты либо по субъекту (Диск: человеку
 * 15 ГБ, организации 100 ГБ). Это ДЕФОЛТ реестра — сегодняшняя константа, чтобы
 * в день запуска поведение продукта не менялось.
 */
export type EntitlementDefaultFree = EntitlementValue | Partial<Record<EntitlementSubjectType, EntitlementValue>>;

/** Сервис-владелец ключа — корзина карточек на странице «Тариф и лимиты». */
export const ENTITLEMENT_SERVICES = {
  workspaces: { order: 10, icon: 'workspace' },
  files: { order: 20, icon: 'drive' },
  contacts: { order: 30, icon: 'people' },
  shop: { order: 40, icon: 'cart' },
  objects: { order: 50, icon: 'objects' },
  legalEntities: { order: 60, icon: 'building' },
  cardSkins: { order: 70, icon: 'crown' },
  notifications: { order: 80, icon: 'bell' },
  keys: { order: 90, icon: 'key' },
  /** Журнал безопасности организации (core/audit): окно, выгрузка, стрим в SIEM */
  audit: { order: 95, icon: 'shield' },
  /** Правила видимости (core/visibility): адресаты оргструктуры, делегирование, объяснение, пресеты, правила, раскрытия */
  visibility: { order: 96, icon: 'eye' },
  /** Жизненный цикл данных организации (core/lifecycle): заморозки (legal hold) */
  lifecycle: { order: 97, icon: 'archive' },
} as const satisfies Record<string, { order: number; icon: string }>;

export type EntitlementServiceKey = keyof typeof ENTITLEMENT_SERVICES;
export const ENTITLEMENT_SERVICE_KEYS = Object.keys(ENTITLEMENT_SERVICES) as EntitlementServiceKey[];

/** Декларация ключа (метаданные; слова — в каталоге). */
export interface EntitlementDef {
  kind: EntitlementKind;
  carrier: EntitlementCarrier;
  /** У каких субъектов ключ имеет смысл (версия плана другого субъекта его не несёт) */
  subjects: readonly EntitlementSubjectType[];
  /** Переопределение слияния грантов (по умолчанию — `mergeOfKind`) */
  merge?: EntitlementMerge;
  unit?: EntitlementUnit;
  /** Только у quota; отсутствует — квота без периода */
  period?: EntitlementPeriod;
  defaultFree: EntitlementDefaultFree;
  /** Есть провайдер расхода (счётчик «12 из 50»); без него UI показывает только потолок */
  hasUsage: boolean;
  service: EntitlementServiceKey;
  /** Ключ каталога подписи ключа (`entitlements.keys.<id>`) */
  labelKey: string;
}

/** Слияние грантов по виду ключа (Stigg/Schematic: feature=OR, limit=MAX, quota=SUM). */
export function mergeOfKind(kind: EntitlementKind): EntitlementMerge {
  switch (kind) {
    case 'feature':
      return 'or';
    case 'limit':
      return 'max';
    case 'quota':
      return 'sum';
    default:
      return 'rank';
  }
}

/** Свободное значение ключа для субъекта данного типа. */
export function defaultFreeFor(def: EntitlementDef, subjectType: EntitlementSubjectType): EntitlementValue {
  const raw = def.defaultFree;
  if (raw !== null && typeof raw === 'object') {
    const v = raw[subjectType];
    return v === undefined ? (def.kind === 'feature' ? false : 0) : v;
  }
  return raw;
}

/** Значение годится для ключа этого вида? (feature — boolean; остальное — число ≥ 0 либо null) */
export function isValidEntitlementValue(def: EntitlementDef, value: unknown): value is EntitlementValue {
  if (def.kind === 'feature') return typeof value === 'boolean';
  if (value === null) return def.kind !== 'config';
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/** Хелпер объявления файла сервиса: сохраняет литеральные ключи и проверяет форму. */
export function defineEntitlements<const T extends Record<string, EntitlementDef>>(defs: T): T {
  return defs;
}
