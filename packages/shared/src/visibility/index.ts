// ============================================================
// core/visibility — единый реестр ТИПОВ ЗАПИСЕЙ (сливается из файлов сервисов)
// ============================================================
// Новый тип = +1 файл `<service>.ts` (или строка в файле сервиса) + подписи
// `visibility.types.<t>.title|sections.<s>.title|fields.<f>.label` в трёх каталогах +
// `VisibilityTypeProvider` в API (без него бут падает) + строки в канареечном сьюте.
// Union `VisibilityRecordType` ВЫВОДИТСЯ из реестра, руками не пишется; страж
// `pnpm check:visibility` сверяет реестр с каталогами, ПДн-колонками, провайдерами и
// payload-типами уведомлений/вебхуков/аналитики/аудита.

import {
  VISIBILITY_CLASS_RANK,
  VISIBILITY_KIND_MASKS,
  VISIBILITY_LEVELS,
  type VisibilityDefaults,
  type VisibilityFieldDef,
  type VisibilityFieldGroup,
  type VisibilityLevel,
  type VisibilityRelativeKind,
  type VisibilityTypeDef,
} from './types';
import type { WorkspaceRole } from '../constants/roles';
import { USER_CARD_VISIBILITY } from './user-card';
import { WORKSPACE_CARD_VISIBILITY } from './workspace-card';
import { STAFF_VISIBILITY } from './staff';
import { HR_VISIBILITY } from './hr';
import { OBJECTS_VISIBILITY } from './objects';
import { COUNTERPARTIES_VISIBILITY } from './counterparties';

export * from './types';
export * from './masks';

const REGISTRY_RAW = {
  ...USER_CARD_VISIBILITY,
  ...WORKSPACE_CARD_VISIBILITY,
  ...STAFF_VISIBILITY,
  ...HR_VISIBILITY,
  ...OBJECTS_VISIBILITY,
  ...COUNTERPARTIES_VISIBILITY,
} as const satisfies Record<string, VisibilityTypeDef>;

/** Union типов записей — выводится из реестра. */
export type VisibilityRecordType = keyof typeof REGISTRY_RAW;

type SectionsOf<T extends VisibilityRecordType> = (typeof REGISTRY_RAW)[T]['sections'];

/** Ключи полей типа (из всех секций) — ключ вне реестра в `shape()` не компилируется. */
export type VisibilityFieldKeyOf<T extends VisibilityRecordType> = {
  [S in keyof SectionsOf<T>]: SectionsOf<T>[S] extends { fields: infer F } ? keyof F & string : never;
}[keyof SectionsOf<T>];

export const VISIBILITY_REGISTRY: Readonly<Record<VisibilityRecordType, VisibilityTypeDef>> = REGISTRY_RAW;
export const VISIBILITY_TYPE_KEYS = Object.keys(VISIBILITY_REGISTRY) as VisibilityRecordType[];

export function isVisibilityRecordType(value: unknown): value is VisibilityRecordType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VISIBILITY_REGISTRY, value);
}

export function visibilityTypeDef(type: string): VisibilityTypeDef | undefined {
  return isVisibilityRecordType(type) ? VISIBILITY_REGISTRY[type] : undefined;
}

/** Поле типа с секцией (плоский индекс; ключ поля уникален в пределах типа — страж). */
export interface VisibilityFieldEntry {
  key: string;
  section: string;
  def: VisibilityFieldDef;
}

const FIELD_INDEX = new Map<string, Map<string, VisibilityFieldEntry>>();
function indexOf(type: string): Map<string, VisibilityFieldEntry> {
  let idx = FIELD_INDEX.get(type);
  if (idx) return idx;
  idx = new Map();
  const def = visibilityTypeDef(type);
  if (def) {
    for (const [section, s] of Object.entries(def.sections)) {
      for (const [key, f] of Object.entries(s.fields)) if (!idx.has(key)) idx.set(key, { key, section, def: f });
    }
  }
  FIELD_INDEX.set(type, idx);
  return idx;
}

/** Все поля типа в порядке реестра. */
export function visibilityFieldsOf(type: string): VisibilityFieldEntry[] {
  return [...indexOf(type).values()];
}

export function visibilityFieldEntry(type: string, fieldKey: string): VisibilityFieldEntry | undefined {
  return indexOf(type).get(fieldKey);
}

/** Группы, в которых у типа есть поля (порядок — по первому появлению). */
export function visibilityGroupsOf(type: string): VisibilityFieldGroup[] {
  const out: VisibilityFieldGroup[] = [];
  for (const e of visibilityFieldsOf(type)) if (!out.includes(e.def.group)) out.push(e.def.group);
  return out;
}

/**
 * Умолчания поля — наследование тип → секция → поле (по ключам, не слиянием мешков:
 * поле, назвавшее `roles`, переопределяет роли целиком — так умолчание читается глазами).
 */
export function visibilityFieldDefaults(type: string, fieldKey: string): VisibilityDefaults {
  const t = visibilityTypeDef(type);
  const e = visibilityFieldEntry(type, fieldKey);
  if (!t || !e) return {};
  const s = t.sections[e.section]?.defaults ?? {};
  const f = e.def.defaults ?? {};
  return {
    roles: f.roles ?? s.roles ?? t.defaults.roles,
    relative: f.relative ?? s.relative ?? t.defaults.relative,
    reveal: f.reveal ?? s.reveal ?? t.defaults.reveal,
    audiences: f.audiences ?? s.audiences ?? t.defaults.audiences,
  };
}

/** Поле настраивается (строка в матрице/таблице)? */
export function isVisibilityFieldConfigurable(type: string, fieldKey: string): boolean {
  const e = visibilityFieldEntry(type, fieldKey);
  return !!e && e.def.configurable !== false;
}

/**
 * Проверки реестра — общий источник для смоука бута API и стража `check:visibility`.
 * Пустой массив = реестр цел.
 */
export function visibilityRegistryProblems(): string[] {
  const problems: string[] = [];
  const ROLES: WorkspaceRole[] = ['owner', 'admin', 'manager', 'staff', 'trainee', 'contractor'];
  const levels = new Set<string>(VISIBILITY_LEVELS);
  for (const type of VISIBILITY_TYPE_KEYS) {
    const t = VISIBILITY_REGISTRY[type];
    const seen = new Set<string>();
    for (const f of t.floor) if (seen.has(f)) problems.push(`${type}: floor field "${f}" is listed twice`);
    for (const f of t.floor) seen.add(f);
    for (const [section, s] of Object.entries(t.sections)) {
      for (const [key, f] of Object.entries(s.fields)) {
        const at = `${type}.${key}`;
        if (seen.has(key)) problems.push(`${at}: field key is not unique in the type (floor or another section)`);
        seen.add(key);
        if (!/^[a-z][A-Za-z0-9]*$/.test(key)) problems.push(`${at}: field key must be camelCase`);
        const allowed = VISIBILITY_KIND_MASKS[f.kind];
        for (const m of f.masks ?? []) {
          if (m !== 'hidden' && !allowed.includes(m)) problems.push(`${at}: mask "${m}" is not allowed for kind "${f.kind}"`);
        }
        if (f.control === 'subject' && t.owner !== 'user') problems.push(`${at}: personal (subject) field in a type owned by "${t.owner}"`);
        if (f.control === 'controller' && t.owner !== 'workspace') problems.push(`${at}: controller field in a type owned by "${t.owner}"`);
        if ((f.class === 'restricted' || f.class === 'secret') && !(f.masks ?? []).some((m) => m !== 'hidden')) {
          problems.push(`${at}: class "${f.class}" needs a partial mask (owners see a mask, not nothing)`);
        }
        if (f.class === 'secret' && (f.self ?? 'full') === 'full') problems.push(`${at}: a secret field is never full, not even to the subject (self must be "policy" or "hidden")`);
        if (f.reciprocal && f.kind !== 'presence') problems.push(`${at}: reciprocal is allowed only for presence`);
        if ((f.mandatoryVisible ?? []).includes('self') && t.subject !== 'user') problems.push(`${at}: mandatoryVisible self needs subject "user"`);
        if ((f.mandatoryVisible ?? []).includes('self') && (f.self ?? 'full') !== 'full') {
          problems.push(`${at}: mandatoryVisible self contradicts self "${f.self}" (the subject must see the field in full)`);
        }
        if (f.moneyBuckets) {
          if (f.kind !== 'money') problems.push(`${at}: moneyBuckets on a non-money field`);
          for (let i = 1; i < f.moneyBuckets.length; i++) {
            if (f.moneyBuckets[i]! <= f.moneyBuckets[i - 1]!) problems.push(`${at}: moneyBuckets must ascend`);
          }
        }
        if ((f.masks ?? []).includes('money_bucket') && !f.moneyBuckets?.length) problems.push(`${at}: money_bucket mask needs moneyBuckets`);
        const d = visibilityFieldDefaults(type, key);
        if (f.control === 'controller') {
          for (const r of ROLES) {
            const lv = d.roles?.[r];
            if (!lv || !levels.has(lv)) problems.push(`${at}: no default level for role "${r}"`);
          }
          if (f.class === 'secret' && d.reveal?.length) problems.push(`${at}: a secret field cannot be revealed (defaults.reveal must be empty)`);
          if (d.audiences) problems.push(`${at}: controller field cannot have personal audiences`);
        } else {
          if (!d.audiences) problems.push(`${at}: personal field needs defaults.audiences`);
          if (d.roles || d.relative) problems.push(`${at}: personal field cannot have role/relative defaults`);
        }
        for (const src of f.derivedFrom ?? []) {
          const [srcType, srcField] = src.includes('.') && !visibilityFieldEntry(type, src) ? splitQualified(src) : [type, src];
          const se = srcType ? visibilityFieldEntry(srcType, srcField) : undefined;
          if (!se) {
            problems.push(`${at}: derivedFrom "${src}" is not a registered field`);
            continue;
          }
          if (VISIBILITY_CLASS_RANK[f.class] < VISIBILITY_CLASS_RANK[se.def.class]) {
            problems.push(`${at}: derived field class "${f.class}" is lower than its input "${src}" ("${se.def.class}")`);
          }
        }
      }
    }
    if (t.subject === 'none') {
      for (const e of visibilityFieldsOf(type)) {
        const rel = visibilityFieldDefaults(type, e.key).relative as Partial<Record<VisibilityRelativeKind, VisibilityLevel>> | undefined;
        if (rel?.manager_of) problems.push(`${type}.${e.key}: manager_of needs a subject`);
      }
    }
  }
  return problems;
}

/** `hr.employment.salaryAmount` → [`hr.employment`, `salaryAmount`] (тип сам содержит точку). */
function splitQualified(qualified: string): [string | undefined, string] {
  for (const type of VISIBILITY_TYPE_KEYS) {
    if (qualified.startsWith(`${type}.`)) return [type, qualified.slice(type.length + 1)];
  }
  return [undefined, qualified];
}
