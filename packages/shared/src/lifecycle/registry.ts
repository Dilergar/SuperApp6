// ============================================================
// core/lifecycle — единый реестр ЖИЗНЕННОГО ЦИКЛА (сливается из файлов областей)
// ============================================================
// Новое хранилище (модель, таблица, профиль файлов, семейство ключей Redis, производное
// хранилище) = +1 запись в файле области + `lifecycle.policies|blobs|redis|derived|tables.
// <id>.title` в трёх каталогах. Проверки ниже — общий источник для смоука бута API и стража
// `pnpm check:lifecycle` (он же сверяет реестр со схемой Prisma, миграциями и кодом).
import { AUDIT_REGISTRY } from '../audit';
import { CORE_LIFECYCLE } from './core';
import { MESSENGER_LIFECYCLE } from './messenger';
import { PERSONAL_LIFECYCLE } from './personal';
import { BLOB_LIFECYCLE, DERIVED_LIFECYCLE, REDIS_LIFECYCLE, TABLE_LIFECYCLE } from './stores';
import {
  LIFECYCLE_CITATIONS,
  LIFECYCLE_DATA_CLASSES,
  LIFECYCLE_EDGE_KINDS,
  LIFECYCLE_EVENTS,
  LIFECYCLE_FOREVER,
  LIFECYCLE_HOLD_REQUIRED_CLASSES,
  LIFECYCLE_ROOTS,
  LIFECYCLE_SUBJECT_ROLES,
  type LifecycleDataClass,
  type LifecycleDuration,
  type LifecycleEffectiveRetention,
  type LifecyclePolicy,
  type LifecyclePolicyInput,
  type LifecycleStoreKind,
} from './types';
import { WORKSPACES_LIFECYCLE } from './workspaces';

/** Файлы областей — по отдельности, чтобы страж видел дубли id между ними (спред молча перезаписал бы). */
export const LIFECYCLE_AREAS = {
  core: CORE_LIFECYCLE,
  messenger: MESSENGER_LIFECYCLE,
  workspaces: WORKSPACES_LIFECYCLE,
  personal: PERSONAL_LIFECYCLE,
  tables: TABLE_LIFECYCLE,
  blobs: BLOB_LIFECYCLE,
  redis: REDIS_LIFECYCLE,
  derived: DERIVED_LIFECYCLE,
} as const satisfies Record<string, Record<string, LifecyclePolicyInput>>;

const RAW = {
  ...CORE_LIFECYCLE,
  ...MESSENGER_LIFECYCLE,
  ...WORKSPACES_LIFECYCLE,
  ...PERSONAL_LIFECYCLE,
  ...TABLE_LIFECYCLE,
  ...BLOB_LIFECYCLE,
  ...REDIS_LIFECYCLE,
  ...DERIVED_LIFECYCLE,
};

/** id политики — выводится из реестра (модель Prisma или `<kind>:<name>`). */
export type LifecyclePolicyId = keyof typeof RAW;

function normalize(id: string, input: LifecyclePolicyInput): LifecyclePolicy {
  return { ...input, id, store: input.store ?? { kind: 'model', model: id } };
}

export const LIFECYCLE_POLICIES: Readonly<Record<LifecyclePolicyId, LifecyclePolicy>> = Object.freeze(
  Object.fromEntries(Object.entries(RAW).map(([id, p]) => [id, normalize(id, p as LifecyclePolicyInput)])),
) as Readonly<Record<LifecyclePolicyId, LifecyclePolicy>>;

export const LIFECYCLE_POLICY_IDS = Object.keys(LIFECYCLE_POLICIES) as LifecyclePolicyId[];

export function isLifecyclePolicyId(value: unknown): value is LifecyclePolicyId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LIFECYCLE_POLICIES, value);
}

export function lifecyclePolicy(id: string): LifecyclePolicy | undefined {
  return isLifecyclePolicyId(id) ? LIFECYCLE_POLICIES[id] : undefined;
}

export function lifecyclePoliciesOf(kind: LifecycleStoreKind): LifecyclePolicy[] {
  return LIFECYCLE_POLICY_IDS.map((id) => LIFECYCLE_POLICIES[id]).filter((p) => p.store.kind === kind);
}

/** Политика модели Prisma по имени модели. */
export function lifecycleModelPolicy(model: string): LifecyclePolicy | undefined {
  const p = lifecyclePolicy(model);
  return p?.store.kind === 'model' ? p : undefined;
}

/**
 * Путь подписи в каталоге `lifecycle` (`<путь>.title`): модели — `policies.<Model>`, прочие
 * хранилища — своя группа. Точка внутри имени (схема таблицы) в ключе каталога запрещена
 * (next-intl делит по точке) — заменяется подчёркиванием.
 */
export function lifecycleCatalogPath(policy: Pick<LifecyclePolicy, 'id' | 'store'>): string {
  switch (policy.store.kind) {
    case 'model':
      return `policies.${policy.store.model}`;
    case 'table':
      return `tables.${policy.store.table.replace(/\./g, '_')}`;
    case 'blob':
      return `blobs.${policy.store.profile}`;
    case 'redis':
      return `redis.${policy.store.family}`;
    case 'derived':
      return `derived.${policy.store.name}`;
  }
}

/** Ключ журнала, доказывающий прогон политики (явный или по способу принуждения). */
export function lifecycleProofEvent(policy: LifecyclePolicy): string {
  if (policy.proofEvent) return policy.proofEvent;
  return policy.enforcement.kind === 'drop_partition' ? 'lifecycle.partition.dropped' : 'lifecycle.purge.run';
}

/** Классы данных, у которых организация выбирает срок (есть хотя бы одна настраиваемая политика). */
export function lifecycleTenantConfigurableClasses(): LifecycleDataClass[] {
  const out = new Set<LifecycleDataClass>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const p = LIFECYCLE_POLICIES[id];
    if (p.retention.tenantConfigurable) out.add(p.dataClass);
  }
  return LIFECYCLE_DATA_CLASSES.filter((c) => out.has(c));
}

/** Политики класса, чей срок берётся из настройки организации. */
export function lifecycleTenantConfigurablePolicies(dataClass: LifecycleDataClass): LifecyclePolicy[] {
  return LIFECYCLE_POLICY_IDS.map((id) => LIFECYCLE_POLICIES[id]).filter((p) => p.dataClass === dataClass && p.retention.tenantConfigurable);
}

// ============================================================
// Длительности и действующий срок
// ============================================================

/** Длительность корректна: целые сутки > 0 или `'forever'`. Строка-число — НЕ длительность (pg_partman #811). */
export function isLifecycleDuration(value: unknown): value is LifecycleDuration {
  return value === LIFECYCLE_FOREVER || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

/** `'forever'` = +∞ для сравнений. */
export function lifecycleDaysValue(d: LifecycleDuration): number {
  return d === LIFECYCLE_FOREVER ? Number.POSITIVE_INFINITY : d;
}

function minDuration(a: LifecycleDuration, b: LifecycleDuration): LifecycleDuration {
  return lifecycleDaysValue(a) <= lifecycleDaysValue(b) ? a : b;
}

function maxDuration(a: LifecycleDuration, b: LifecycleDuration): LifecycleDuration {
  return lifecycleDaysValue(a) >= lifecycleDaysValue(b) ? a : b;
}

/** Пресеты срока для организации (Slack/WhatsApp): «Вечно · 1 год · 90 · 30 · 7 · 1 день». */
export const LIFECYCLE_RETENTION_PRESETS: readonly LifecycleDuration[] = [LIFECYCLE_FOREVER, 365, 90, 30, 7, 1];
/** Таймер автоудаления сообщений в чате (человек): выкл · 1 · 7 · 30 дней. */
export const LIFECYCLE_CHAT_TIMER_PRESETS: readonly number[] = [1, 7, 30];
/** Сокращение срока организацией вступает через N дней (уведомление всем членам + окно экспорта). */
export const LIFECYCLE_SHORTENING_DELAY_DAYS = 30;

/**
 * Коридор срока, который может выбрать организация: [пол закона; min(потолок политики,
 * потолок тарифа)]. Потолок тарифа `null`/`undefined` — тариф не ограничивает.
 */
export function lifecycleCorridor(policy: LifecyclePolicy, planCeilingDays?: LifecycleDuration | null): { min: LifecycleDuration; max: LifecycleDuration } {
  const min = policy.retention.floorDays ?? 1;
  let max: LifecycleDuration = policy.retention.ceilingDays ?? LIFECYCLE_FOREVER;
  if (planCeilingDays !== undefined && planCeilingDays !== null) max = minDuration(max, planCeilingDays);
  return { min, max: maxDuration(max, min) };
}

export interface LifecycleRetentionInput {
  policy: LifecyclePolicy;
  /** Legal hold на субъекте / записи / пространстве */
  held?: boolean;
  /** Срок, выбранный организацией для класса данных (только у `tenantConfigurable`) */
  tenantDays?: LifecycleDuration | null;
  /** Таймер человека (только у `userConfigurable`) */
  userDays?: LifecycleDuration | null;
  /** Потолок тарифа (`lifecycle.retention.<class>.ceilingDays`) */
  planCeilingDays?: LifecycleDuration | null;
  /** Субъект строки стирается (строки, которые его политика стирания удаляет) */
  erasure?: boolean;
}

/**
 * Действующий срок строки: legal hold > пол закона > стирание субъекта > потолок > умолчание.
 * Несколько «хранить» — побеждает длиннее, несколько «удалить» — короче. `days = 0` — удалить
 * сейчас (стирание субъекта без пола закона).
 */
export function resolveLifecycleRetention(input: LifecycleRetentionInput): LifecycleEffectiveRetention & { days: LifecycleDuration | 0 } {
  const { policy } = input;
  if (input.held && policy.holdAware) return { days: LIFECYCLE_FOREVER, source: 'hold' };
  let days: LifecycleDuration | 0 = policy.retention.defaultDays;
  let source: LifecycleEffectiveRetention['source'] = 'default';
  if (policy.retention.tenantConfigurable && isLifecycleDuration(input.tenantDays)) {
    days = input.tenantDays;
    source = 'tenant';
  }
  if (policy.retention.userConfigurable && isLifecycleDuration(input.userDays) && lifecycleDaysValue(input.userDays) < lifecycleDaysValue(days as LifecycleDuration)) {
    days = input.userDays;
    source = 'user';
  }
  const ceilings = [policy.retention.ceilingDays, input.planCeilingDays].filter(isLifecycleDuration);
  for (const c of ceilings) {
    if (lifecycleDaysValue(c) < lifecycleDaysValue(days as LifecycleDuration)) {
      days = c;
      source = 'ceiling';
    }
  }
  if (input.erasure && (policy.onSubjectErasure.kind === 'hard_delete' || policy.onSubjectErasure.kind === 'crypto_shred')) {
    days = 0;
    source = 'erasure';
  }
  const floor = policy.retention.floorDays;
  if (floor !== undefined && (days === 0 || lifecycleDaysValue(days) < lifecycleDaysValue(floor))) {
    days = floor;
    source = 'floor';
  }
  return { days, source };
}

// ============================================================
// Граф удаления
// ============================================================

const DELETION_EDGE_KINDS = new Set(['deep', 'refcount', 'async_delete']);

/** Рёбра, входящие в политику (кто её удаляет). */
export function lifecycleIncomingEdges(id: string): Array<{ from: string; kind: string; via?: string }> {
  const out: Array<{ from: string; kind: string; via?: string }> = [];
  for (const from of LIFECYCLE_POLICY_IDS) {
    for (const e of LIFECYCLE_POLICIES[from].edges) if (e.to === id) out.push({ from, kind: e.kind, ...(e.via ? { via: e.via } : {}) });
  }
  return out;
}

/**
 * Порядок удаления набора политик: дети раньше родителей по `deep`-рёбрам (RESTRICT-ключи
 * не дадут удалить родителя первым). Петли (дерево на себя) игнорируются; при цикле между
 * разными политиками — порядок реестра для оставшихся (страж такие циклы называет).
 */
export function lifecycleDeletionOrder(ids: readonly string[]): string[] {
  const set = new Set(ids);
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const e of lifecyclePolicy(id)?.edges ?? []) if (e.kind === 'deep' && e.to !== id && set.has(e.to)) visit(e.to);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of ids) visit(id);
  return order;
}

// ============================================================
// Каскад удаления организации
// ============================================================

/** Строка самой организации — всегда последний шаг каскада. */
export const LIFECYCLE_TENANT_ROOT = 'Workspace';

/**
 * Шаг каскада удаления организации:
 *  - `hook` — шаг модуля-владельца (`LifecycleTenantHookRegistry`), один на ключ, сколько бы
 *    политик его ни объявили (`files.owned` — файл и все профили байтов);
 *  - `batched` — строки политики уходят пачками раннера по колонке организации.
 */
export type LifecycleTenantPurgeStep =
  | { kind: 'hook'; key: string; policies: readonly string[] }
  | { kind: 'batched'; key: string; policy: string; column: string };

function tenantStepOf(p: LifecyclePolicy): { key: string; kind: 'hook' | 'batched'; column?: string } | null {
  const tp = p.onTenantPurge;
  if (tp.kind === 'registry_hook') return { key: tp.key, kind: 'hook' };
  if (tp.kind === 'retain_legal' && tp.hook) return { key: tp.hook, kind: 'hook' };
  if (tp.kind === 'batched_delete') return { key: `batched:${p.id}`, kind: 'batched', column: tp.column };
  return null;
}

/**
 * План каскада окончательного удаления организации — из реестра, не из кода модуля
 * организаций (замена «знания в голове»: раньше порядок жил комментариями в purgeWorkspace).
 *
 * Порядок:
 *  - `deep`: дети раньше родителей (RESTRICT-ключи и «ребёнок без родителя» иначе);
 *  - `refcount`: ссылающиеся раньше файла — файл умирает с последним ссылающимся, сперва
 *    Диск, документы и записи звонков снимают свои ссылки своим путём;
 *  - политики без своего шага (каскад FK, «по закону», ссылки файлов, которые модуль снимает
 *    своим путём) уходят вместе с шагом родителя — их рёбра считаются рёбрами родителя
 *    (вложения заметок и сообщений — `FileLink` → файл: Заметки и Мессенджер раньше файлов);
 *  - строка организации (`Workspace`, хук `workspaces.row`) — последней;
 *  - прочее — в порядке реестра. Цикл — ошибка реестра (страж и смоук бута).
 */
export function lifecycleTenantPurgePlan(): LifecycleTenantPurgeStep[] {
  const stepOfPolicy = new Map<string, string>();
  const steps = new Map<string, LifecycleTenantPurgeStep>();
  const members = new Map<string, string[]>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const s = tenantStepOf(LIFECYCLE_POLICIES[id]);
    if (!s) continue;
    stepOfPolicy.set(id, s.key);
    if (!members.has(s.key)) members.set(s.key, []);
    members.get(s.key)!.push(id);
    if (!steps.has(s.key)) steps.set(s.key, s.kind === 'hook' ? { kind: 'hook', key: s.key, policies: [] } : { kind: 'batched', key: s.key, policy: id, column: s.column! });
  }
  for (const [key, step] of steps) if (step.kind === 'hook') (step.policies as string[]).push(...members.get(key)!);
  const rootKey = stepOfPolicy.get(LIFECYCLE_TENANT_ROOT);

  // Замыкание шага: его политики + всё, что уходит с ними (deep / async_delete) без своего шага
  const closure = (key: string): Set<string> => {
    const out = new Set<string>(members.get(key));
    const queue = [...out];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of lifecyclePolicy(cur)?.edges ?? []) {
        if ((e.kind !== 'deep' && e.kind !== 'async_delete') || out.has(e.to) || stepOfPolicy.has(e.to)) continue;
        out.add(e.to);
        queue.push(e.to);
      }
    }
    return out;
  };

  // before[a] = шаги, которые обязаны пройти раньше a
  const before = new Map<string, Set<string>>();
  for (const key of steps.keys()) before.set(key, new Set());
  for (const key of steps.keys()) {
    if (key === rootKey) continue;
    for (const pid of closure(key)) {
      for (const e of lifecyclePolicy(pid)?.edges ?? []) {
        const other = stepOfPolicy.get(e.to);
        if (!other || other === key || other === rootKey) continue;
        if (e.kind === 'deep') before.get(key)!.add(other);
        else if (e.kind === 'refcount') before.get(other)!.add(key);
      }
    }
  }

  // Кан с порядком реестра как разрывом ничьих; корень — в конце
  const order: string[] = [];
  const placed = new Set<string>();
  const pending = [...steps.keys()].filter((k) => k !== rootKey);
  while (pending.length) {
    const i = pending.findIndex((k) => [...before.get(k)!].every((d) => placed.has(d)));
    if (i < 0) throw new Error(`tenant purge plan has a cycle among: ${pending.join(', ')}`);
    const [k] = pending.splice(i, 1);
    placed.add(k);
    order.push(k);
  }
  if (rootKey) order.push(rootKey);
  return order.map((k) => steps.get(k)!);
}

/**
 * Классы данных, которые заморозка вообще держит (есть политика с `holdAware`). Заморозка
 * класса без таких политик (секреты входа, кэши) не держала бы ничего — пикер её не
 * предлагает, сервер отвергает.
 */
export function lifecycleHoldableClasses(): LifecycleDataClass[] {
  const out = new Set<LifecycleDataClass>();
  for (const id of LIFECYCLE_POLICY_IDS) if (LIFECYCLE_POLICIES[id].holdAware) out.add(LIFECYCLE_POLICIES[id].dataClass);
  return LIFECYCLE_DATA_CLASSES.filter((c) => out.has(c));
}

// ============================================================
// План стирания человека (оркестратор `LifecycleErasureService`)
// ============================================================

/**
 * Корневой шаг стирания человека — модуль пользователей (`anonymizeAccount`): скрыть аккаунт,
 * стереть ПДн строки `User`, погасить сессии, связи Окружения, тариф, аналитику, ключи. Всегда
 * ПЕРВЫМ: остальные шаги идут по уже скрытому аккаунту.
 */
export const LIFECYCLE_SUBJECT_ROOT_HOOK = 'users.account';

/**
 * Шаг стирания человека:
 *  - `hook` — шаг модуля-владельца (`LifecycleSubjectHookRegistry`), один на ключ;
 *  - `generic` — строки политики, где любая из колонок `by` = человек: `delete` удаляет,
 *    `pseudonymize` пишет в строковые поля метку «удалённый пользователь», `redact` — NULL.
 */
export type LifecycleSubjectErasureStep =
  /** `covers` — политики шага и всё, что уходит с ними по рёбрам deep/async_delete без своего шага */
  | { kind: 'hook'; key: string; policies: readonly string[]; covers: readonly string[] }
  | {
      kind: 'generic';
      key: string;
      policy: string;
      action: 'delete' | 'pseudonymize' | 'redact';
      by: readonly string[];
      fields: readonly string[];
      personalOnly: boolean;
    };

function subjectStepOf(p: LifecyclePolicy): LifecycleSubjectErasureStep | null {
  const se = p.onSubjectErasure;
  if ('hook' in se && se.hook) return { kind: 'hook', key: se.hook, policies: [], covers: [] };
  if (se.kind === 'hard_delete') return { kind: 'generic', key: `generic:${p.id}`, policy: p.id, action: 'delete', by: se.by ?? [], fields: [], personalOnly: !!se.personalOnly };
  if (se.kind === 'pseudonymize' || se.kind === 'redact') {
    return { kind: 'generic', key: `generic:${p.id}`, policy: p.id, action: se.kind, by: se.by ?? [], fields: se.fields, personalOnly: false };
  }
  return null;
}

/**
 * План стирания человека — из реестра. Корень (`users.account`) — первым; дальше по рёбрам:
 * `deep` — дети раньше родителей, `refcount` — ссылающиеся раньше файла (Диск, Заметки,
 * Документы, Диктофон снимают свои ссылки своим путём, потом файлы человека); прочее — в
 * порядке реестра. Цикл — ошибка реестра (страж и смоук бута).
 */
export function lifecycleSubjectErasurePlan(): LifecycleSubjectErasureStep[] {
  const stepOfPolicy = new Map<string, string>();
  const steps = new Map<string, LifecycleSubjectErasureStep>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const s = subjectStepOf(LIFECYCLE_POLICIES[id]);
    if (!s) continue;
    stepOfPolicy.set(id, s.key);
    const prev = steps.get(s.key);
    if (!prev) steps.set(s.key, s);
    const cur = steps.get(s.key)!;
    if (cur.kind === 'hook') (cur.policies as string[]).push(id);
  }
  // Замыкание шага: его политики + всё, что уходит с ними (deep / async_delete) без своего шага —
  // рёбра `refcount` детей (узел Диска → файл) считаются рёбрами шага родителя (Диска)
  const closure = (key: string): Set<string> => {
    const out = new Set<string>([...stepOfPolicy].filter(([, k]) => k === key).map(([id]) => id));
    const queue = [...out];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of lifecyclePolicy(cur)?.edges ?? []) {
        if ((e.kind !== 'deep' && e.kind !== 'async_delete') || out.has(e.to) || stepOfPolicy.has(e.to)) continue;
        out.add(e.to);
        queue.push(e.to);
      }
    }
    return out;
  };
  const before = new Map<string, Set<string>>();
  for (const key of steps.keys()) before.set(key, new Set());
  for (const key of steps.keys()) {
    if (key === LIFECYCLE_SUBJECT_ROOT_HOOK) continue;
    for (const pid of closure(key)) {
      for (const e of lifecyclePolicy(pid)?.edges ?? []) {
        const other = stepOfPolicy.get(e.to);
        if (!other || other === key || other === LIFECYCLE_SUBJECT_ROOT_HOOK) continue;
        if (e.kind === 'deep') before.get(key)!.add(other);
        else if (e.kind === 'refcount') before.get(other)!.add(key);
      }
    }
  }
  // Замыкание шага модуля — «что он удаляет на самом деле» (предохранитель заморозок платформы)
  for (const [key, step] of steps) if (step.kind === 'hook') (step.covers as string[]).push(...closure(key));
  const order: string[] = steps.has(LIFECYCLE_SUBJECT_ROOT_HOOK) ? [LIFECYCLE_SUBJECT_ROOT_HOOK] : [];
  const placed = new Set<string>(order);
  const pending = [...steps.keys()].filter((k) => k !== LIFECYCLE_SUBJECT_ROOT_HOOK);
  while (pending.length) {
    const i = pending.findIndex((k) => [...before.get(k)!].every((d) => placed.has(d)));
    if (i < 0) throw new Error(`subject erasure plan has a cycle among: ${pending.join(', ')}`);
    const [k] = pending.splice(i, 1);
    placed.add(k);
    order.push(k);
  }
  return order.map((k) => steps.get(k)!);
}

/**
 * Ключи обработчиков purge и хуков каскада, чья регистрация в API ждёт этапа стройки
 * (`stage` — код этапа плана латиницей: E4 = Э4).
 * Одна правда для стража (`check:lifecycle`) и смоука бута: ключа нет здесь и нет
 * регистрации — красный CI и падение старта.
 */
export const LIFECYCLE_PENDING_KEYS: Readonly<Record<string, { stage: string; as: 'handler' | 'hook' | 'subject_hook' }>> = {
  'lifecycle.exports': { stage: 'E6', as: 'handler' },
};

/** Ключи обработчиков purge (`batched_delete.handler`), хуков каскада организации и хуков стирания человека. */
export function lifecycleRegistrationKeys(): { handlers: string[]; hooks: string[]; subjectHooks: string[] } {
  const handlers = new Set<string>();
  const hooks = new Set<string>();
  const subjectHooks = new Set<string>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const p = LIFECYCLE_POLICIES[id];
    if (p.enforcement.kind === 'batched_delete' && p.enforcement.handler) handlers.add(p.enforcement.handler);
    const s = tenantStepOf(p);
    if (s?.kind === 'hook') hooks.add(s.key);
    const se = p.onSubjectErasure;
    if ('hook' in se && se.hook) subjectHooks.add(se.hook);
  }
  return { handlers: [...handlers].sort(), hooks: [...hooks].sort(), subjectHooks: [...subjectHooks].sort() };
}

/** Ребро loose FK: строки ребёнка без внешнего ключа, которые добирает воркер после удаления родителя. */
export interface LifecycleLooseFkEdge {
  parent: string;
  child: string;
  kind: 'async_delete' | 'async_nullify';
  via: string;
}

/**
 * Рёбра `async_delete` / `async_nullify` реестра по родителям. Корень `User` сюда не входит:
 * строка человека не удаляется (томбстоун), его след стирает оркестратор стирания.
 */
export function lifecycleLooseFkEdges(): LifecycleLooseFkEdge[] {
  const out: LifecycleLooseFkEdge[] = [];
  for (const parent of LIFECYCLE_POLICY_IDS) {
    if (parent === 'User') continue;
    for (const e of LIFECYCLE_POLICIES[parent].edges) {
      if ((e.kind === 'async_delete' || e.kind === 'async_nullify') && e.via) out.push({ parent, child: e.to, kind: e.kind, via: e.via });
    }
  }
  return out;
}

// ============================================================
// Проверки реестра (смоук бута + страж)
// ============================================================

const CITATIONS = new Set<string>(LIFECYCLE_CITATIONS);
const CLASSES = new Set<string>(LIFECYCLE_DATA_CLASSES);
const ROLES = new Set<string>(LIFECYCLE_SUBJECT_ROLES);
const EDGE_KINDS = new Set<string>(LIFECYCLE_EDGE_KINDS);
const EVENTS = new Set<string>(LIFECYCLE_EVENTS);
const HOLD_REQUIRED = new Set<string>(LIFECYCLE_HOLD_REQUIRED_CLASSES);
const TRIGGER_RE = /^(created|lastActivity|parent|event:([a-z.]+))$/;
const ENTITLEMENT_KEY_RE = /^lifecycle\.retention\.([a-z_]+)\.ceilingDays$/;

/** Пустой массив = реестр цел. */
export function lifecycleRegistryProblems(): string[] {
  const problems: string[] = [];
  const add = (at: string, msg: string) => problems.push(`${at}: ${msg}`);

  // Дубли id между файлами областей
  const seen = new Map<string, string>();
  for (const [area, map] of Object.entries(LIFECYCLE_AREAS)) {
    for (const id of Object.keys(map)) {
      const prev = seen.get(id);
      if (prev) add(id, `declared twice (areas "${prev}" and "${area}")`);
      seen.set(id, area);
    }
  }

  const redisPatterns = new Map<string, string>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const p = LIFECYCLE_POLICIES[id];
    const at = id;
    // хранилище и id
    const kind = p.store.kind;
    if (kind === 'model' && !/^[A-Z][A-Za-z0-9]*$/.test(id)) add(at, 'a model policy id must be the Prisma model name');
    if (kind !== 'model' && !id.startsWith(`${kind}:`)) add(at, `a ${kind} policy id must start with "${kind}:"`);
    if (!p.owner) add(at, 'owner module is empty');
    if (!Number.isInteger(p.version) || p.version < 1) add(at, 'version must be an integer ≥ 1');
    if (!CLASSES.has(p.dataClass)) add(at, `unknown data class "${p.dataClass}"`);

    // ключ владельца
    const ok = p.ownerKey;
    if (ok.kind === 'global') {
      if (!ok.reason) add(at, 'global owner key needs a reason');
    } else if (ok.kind === 'polymorphic') {
      if (!ok.typeColumn || !ok.column || !ok.kinds.length) add(at, 'polymorphic owner key needs typeColumn, column and kinds');
    } else if (ok.kind === 'scoped') {
      if (!ok.workspaceColumn) add(at, 'scoped owner key needs workspaceColumn');
    } else if ('via' in ok) {
      if (!lifecyclePolicy(ok.via)) add(at, `owner key via "${ok.via}" is not a registered policy`);
    } else if (!ok.column) add(at, 'owner key needs a column');

    // субъекты
    const subjCols = new Set<string>();
    for (const s of p.subjects) {
      if (!s.column) add(at, 'subject without column');
      if (!ROLES.has(s.role)) add(at, `unknown subject role "${s.role}"`);
      if (subjCols.has(s.column)) add(at, `subject column "${s.column}" listed twice`);
      subjCols.add(s.column);
    }

    // основание
    const lb = p.legalBasis;
    if (lb.kind === 'legal_obligation' && !CITATIONS.has(lb.citation)) add(at, `legal obligation without a known citation ("${lb.citation}")`);
    if (lb.kind === 'legitimate_interest' && !lb.reason) add(at, 'legitimate interest needs a reason');

    // срок: пустое поле = хранить + красный CI
    const r = p.retention;
    if (!TRIGGER_RE.test(r.trigger)) add(at, `unknown retention trigger "${r.trigger}"`);
    const evt = /^event:(.+)$/.exec(r.trigger)?.[1];
    if (evt && !EVENTS.has(evt)) add(at, `unknown retention event "${evt}"`);
    if (r.defaultDays === undefined || r.defaultDays === null) add(at, 'retention.defaultDays is empty (an empty retention would mean «keep» — declare it)');
    for (const [name, v] of [
      ['floorDays', r.floorDays],
      ['defaultDays', r.defaultDays],
      ['ceilingDays', r.ceilingDays],
    ] as const) {
      if (v !== undefined && !isLifecycleDuration(v)) add(at, `retention.${name} must be whole days > 0 or 'forever' (got ${JSON.stringify(v)})`);
    }
    if (isLifecycleDuration(r.defaultDays)) {
      if (r.floorDays !== undefined && isLifecycleDuration(r.floorDays) && lifecycleDaysValue(r.floorDays) > lifecycleDaysValue(r.defaultDays)) add(at, 'floorDays > defaultDays');
      if (r.ceilingDays !== undefined && isLifecycleDuration(r.ceilingDays) && lifecycleDaysValue(r.ceilingDays) < lifecycleDaysValue(r.defaultDays)) add(at, 'ceilingDays < defaultDays');
    }
    if (r.tenantConfigurable) {
      if (r.floorDays === undefined) add(at, 'tenantConfigurable needs a legal floor (floorDays)');
      if (!r.entitlementKey) add(at, 'tenantConfigurable needs entitlementKey (the plan ceiling)');
    }
    if (r.userConfigurable && !p.dataClass.startsWith('user_content')) add(at, 'userConfigurable only for user content');
    if (r.entitlementKey) {
      const m = ENTITLEMENT_KEY_RE.exec(r.entitlementKey);
      if (!m) add(at, `entitlementKey "${r.entitlementKey}" must be lifecycle.retention.<class>.ceilingDays`);
      else if (m[1] !== p.dataClass) add(at, `entitlementKey class "${m[1]}" ≠ data class "${p.dataClass}"`);
    }

    // стирание субъекта
    const se = p.onSubjectErasure;
    if ((se.kind === 'pseudonymize' || se.kind === 'redact') && !se.fields.length) add(at, `${se.kind} needs fields`);
    if (se.kind === 'retain_legal') {
      if (!CITATIONS.has(se.citation)) add(at, `retain_legal without a known citation ("${se.citation}")`);
      if (!isLifecycleDuration(se.untilDays)) add(at, 'retain_legal.untilDays must be a duration');
    }
    if (se.kind === 'none' && !se.reason) add(at, 'onSubjectErasure none needs a reason');
    if (se.kind === 'hard_delete' && se.personalOnly && p.ownerKey.kind !== 'scoped' && p.ownerKey.kind !== 'polymorphic') {
      add(at, 'personalOnly erasure needs a scoped or polymorphic owner key (how else to tell personal rows)');
    }
    if ('hook' in se && se.hook !== undefined && !/^[a-z]+(\.[a-z-]+)+$/.test(se.hook)) add(at, `subject erasure hook "${se.hook}" must be <module>.<step>`);
    if ((se.kind === 'hard_delete' || se.kind === 'pseudonymize' || se.kind === 'redact') && !('hook' in se && se.hook)) {
      // Общий шаг: строки ищутся по явным колонкам субъекта; «кто выдал / отозвал» удаление не ведёт
      const by = se.by ?? [];
      if (!by.length) add(at, `${se.kind} without a hook needs "by" — the subject columns that select the person's rows`);
      for (const col of by) {
        const s = p.subjects.find((x) => x.column === col);
        if (!s) add(at, `erasure column "${col}" is not a subject column`);
        else if (s.role === 'actor') add(at, `erasure column "${col}" has role actor — an actor reference must never select rows to erase (it would erase other people's records)`);
      }
      if (p.store.kind !== 'model' && p.store.kind !== 'table') add(at, `a ${p.store.kind} store cannot be erased by the generic step — declare a hook`);
    }
    if (p.store.kind === 'redis' && se.kind === 'hard_delete') {
      if (se.hook !== 'lifecycle.redis') add(at, 'a Redis family with personal keys is erased by the lifecycle.redis step');
      if (!p.store.subjectPattern || !p.store.subjectPattern.includes('{user}')) add(at, 'a Redis family with personal keys needs a subjectPattern with {user}');
    }

    // удаление организации
    const tp = p.onTenantPurge;
    if (tp.kind === 'registry_hook' && !tp.key) add(at, 'tenant purge hook needs a key');
    if (tp.kind === 'batched_delete' && !tp.column) add(at, 'tenant batched purge needs a column');
    if (tp.kind === 'retain_legal') {
      if (!CITATIONS.has(tp.citation)) add(at, `tenant retain_legal without a known citation ("${tp.citation}")`);
      if (!isLifecycleDuration(tp.untilDays)) add(at, 'tenant retain_legal.untilDays must be a duration');
      if (tp.hook !== undefined && !tp.hook) add(at, 'tenant retain_legal hook key is empty');
    }

    // рёбра
    const edgeKeys = new Set<string>();
    for (const e of p.edges) {
      if (!EDGE_KINDS.has(e.kind)) add(at, `unknown edge kind "${e.kind}"`);
      if (!lifecyclePolicy(e.to)) add(at, `edge to unknown policy "${e.to}"`);
      const k = `${e.to}|${e.via ?? ''}|${e.kind}`;
      if (edgeKeys.has(k)) add(at, `edge ${e.kind} → ${e.to} via ${e.via ?? '-'} is declared twice`);
      edgeKeys.add(k);
    }

    // принуждение
    const en = p.enforcement;
    if (en.kind === 'drop_partition' && (!en.column || !en.period)) add(at, 'drop_partition needs column and period');
    if (en.kind === 'batched_delete') {
      if (!en.column) add(at, 'batched_delete needs a time column');
      for (const [col, values] of Object.entries(en.filter ?? {})) if (!col || !Array.isArray(values) || !values.length) add(at, `filter "${col}" needs a non-empty list`);
    }
    if (en.kind === 'none' && !en.reason) add(at, 'enforcement none needs a reason');
    if (p.extraRules?.length && en.kind !== 'batched_delete') add(at, 'extraRules only with batched_delete');
    for (const rule of p.extraRules ?? []) if (!Number.isInteger(rule.days) || rule.days < 1) add(at, 'extraRules.days must be whole days ≥ 1');
    if (en.kind === 'cascade' && r.trigger !== 'parent') add(at, 'cascade enforcement means the retention trigger is "parent"');
    if (r.trigger === 'parent' && en.kind !== 'cascade' && en.kind !== 'none' && !(r.floorDays !== undefined)) add(at, 'retention with the parent needs cascade enforcement');

    // hold
    if (HOLD_REQUIRED.has(p.dataClass) && !p.holdAware) add(at, `class "${p.dataClass}" must be hold-aware`);

    // доказательство
    const proof = lifecycleProofEvent(p);
    if (!Object.prototype.hasOwnProperty.call(AUDIT_REGISTRY, proof)) add(at, `proof event "${proof}" is not in the audit registry`);

    // Redis: шаблоны не пересекаются между семействами
    if (p.store.kind === 'redis') {
      if (!p.store.patterns.length) add(at, 'redis family needs patterns');
      if (p.store.maxTtlSeconds !== null && (!Number.isInteger(p.store.maxTtlSeconds) || p.store.maxTtlSeconds < 1)) add(at, 'maxTtlSeconds must be a positive integer or null');
      for (const pat of p.store.patterns) {
        const prev = redisPatterns.get(pat);
        if (prev) add(at, `redis pattern "${pat}" is also declared by ${prev}`);
        redisPatterns.set(pat, id);
      }
    }
  }

  // Достижимость DELF: всё, что не global, достижимо из корней по рёбрам
  const reach = new Set<string>(LIFECYCLE_ROOTS);
  const queue: string[] = [...LIFECYCLE_ROOTS];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of lifecyclePolicy(cur)?.edges ?? []) {
      if (!reach.has(e.to)) {
        reach.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const id of LIFECYCLE_POLICY_IDS) {
    const p = LIFECYCLE_POLICIES[id];
    if (p.ownerKey.kind !== 'global' && !reach.has(id)) add(id, `not reachable from the deletion roots (${LIFECYCLE_ROOTS.join(', ')}) — add an edge from its owner`);
    // Каскадная политика обязана иметь того, кто её удаляет
    if (p.enforcement.kind === 'cascade' && !lifecycleIncomingEdges(id).some((e) => DELETION_EDGE_KINDS.has(e.kind))) {
      add(id, 'cascade enforcement without an incoming deep/refcount/async_delete edge — nothing deletes it');
    }
  }
  // Каскад организации обязан упорядочиваться: цикл шагов = удаление, которое никогда не закончится
  try {
    lifecycleTenantPurgePlan();
  } catch (e) {
    add('tenant purge plan', e instanceof Error ? e.message : String(e));
  }
  return problems;
}
