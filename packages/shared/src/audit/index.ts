// ============================================================
// core/audit — единый реестр событий безопасности (сливается из файлов областей)
// ============================================================
// Новое событие = +1 строка в файле области + `audit.events.<key>.title|body` в трёх
// каталогах. Union `AuditEventKey` ВЫВОДИТСЯ из реестра, руками не пишется; страж
// `pnpm check:audit` сверяет реестр с каталогами, запрещённые имена деталей, категорию,
// видимость, окно и то, что у каждого живого ключа есть запись в коде.

import type { z } from 'zod';
import {
  AUDIT_CATEGORIES,
  AUDIT_DENY_DETAIL_WORDS,
  AUDIT_LIMITS,
  auditCategoryOfKey,
  auditDetailWords,
  type AuditCategory,
  type AuditEventDef,
} from './types';
import { isAuditVocab } from './vocab';
import { AUTH_AUDIT_EVENTS } from './auth';
import { ACCOUNT_AUDIT_EVENTS } from './account';
import { ORG_AUDIT_EVENTS } from './org';
import { KEYS_AUDIT_EVENTS } from './keys';
import { PLATFORM_AUDIT_EVENTS } from './platform';
import { PII_AUDIT_EVENTS } from './pii';
import { PD_AUDIT_EVENTS } from './pd';
import { CONSENTS_AUDIT_EVENTS } from './consents';
import { DATA_AUDIT_EVENTS } from './data';
import { DETECT_AUDIT_EVENTS } from './detect';
import { META_AUDIT_EVENTS } from './meta';
import { SHARING_AUDIT_EVENTS } from './sharing';
import { FILES_AUDIT_EVENTS } from './files';
import { AUTHZ_AUDIT_EVENTS } from './authz';
import { LIFECYCLE_AUDIT_EVENTS } from './lifecycle';

export * from './types';
export * from './ocsf';
export * from './vocab';
export { LIFECYCLE_ERASURE_STAGES, LIFECYCLE_HOLD_SCOPES } from './lifecycle';

const REGISTRY_RAW = {
  ...AUTH_AUDIT_EVENTS,
  ...ACCOUNT_AUDIT_EVENTS,
  ...ORG_AUDIT_EVENTS,
  ...KEYS_AUDIT_EVENTS,
  ...PLATFORM_AUDIT_EVENTS,
  ...PII_AUDIT_EVENTS,
  ...PD_AUDIT_EVENTS,
  ...CONSENTS_AUDIT_EVENTS,
  ...DATA_AUDIT_EVENTS,
  ...DETECT_AUDIT_EVENTS,
  ...META_AUDIT_EVENTS,
  ...SHARING_AUDIT_EVENTS,
  ...FILES_AUDIT_EVENTS,
  ...AUTHZ_AUDIT_EVENTS,
  ...LIFECYCLE_AUDIT_EVENTS,
} as const satisfies Record<string, AuditEventDef>;

/** Union ключей — выводится из реестра. Ключ вне реестра в `audit.record()` — ошибка компиляции. */
export type AuditEventKey = keyof typeof REGISTRY_RAW;

/** Детали события — ровно то, что разрешает его схема. */
export type AuditDetailsOf<K extends AuditEventKey> = z.input<(typeof REGISTRY_RAW)[K]['details']>;

export const AUDIT_REGISTRY: Readonly<Record<AuditEventKey, AuditEventDef>> = REGISTRY_RAW;
export const AUDIT_EVENT_KEYS = Object.keys(AUDIT_REGISTRY) as AuditEventKey[];

export function isAuditEventKey(value: unknown): value is AuditEventKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_REGISTRY, value);
}

/** Декларация события; для ключа вне реестра — undefined (строка из старой версии реестра). */
export function auditEventDef(key: string): AuditEventDef | undefined {
  return isAuditEventKey(key) ? AUDIT_REGISTRY[key] : undefined;
}

/** Ключи категорий в порядке реестра. */
export function auditKeysOf(categories: readonly AuditCategory[]): AuditEventKey[] {
  const set = new Set<string>(categories);
  return AUDIT_EVENT_KEYS.filter((k) => set.has(AUDIT_REGISTRY[k].category));
}

/** Оспоримые ключи («Это не я» у строки ленты). */
export const AUDIT_DISPUTABLE_KEYS = AUDIT_EVENT_KEYS.filter((k) => AUDIT_REGISTRY[k].disputable);
/** Ключи без окна ленты человека (законный учёт действий с ПДн). */
export const AUDIT_WINDOW_EXEMPT_KEYS = AUDIT_EVENT_KEYS.filter((k) => AUDIT_REGISTRY[k].windowExempt);

// ---- Фильтры зрителей (чипы ленты): группа = набор ключей, сервер строит `event_key = ANY(…)` ----

/** Чипы ленты человека: «Все · Входы · Устройства · Пароль и номер · Организации · Ключи и приложения · Мои данные · Раскрытия». */
export const AUDIT_PERSON_FILTERS = ['all', 'logins', 'devices', 'credentials', 'orgs', 'keys', 'data', 'reveals'] as const;
export type AuditPersonFilter = (typeof AUDIT_PERSON_FILTERS)[number];

/** Чипы журнала организации: «Все · Люди и роли · Устройства · Доступы · Ключи и интеграции · Выгрузки · Файлы · Согласия · Раскрытия». */
export const AUDIT_ORG_FILTERS = ['all', 'people', 'devices', 'sharing', 'keys', 'exports', 'files', 'consents', 'reveals'] as const;
export type AuditOrgFilter = (typeof AUDIT_ORG_FILTERS)[number];

const byPrefix = (...prefixes: string[]) => AUDIT_EVENT_KEYS.filter((k) => prefixes.some((p) => k === p || k.startsWith(`${p}.`)));

/** Ключи чипа ленты человека (`all` → null: без фильтра по ключу). */
export function auditPersonFilterKeys(filter: AuditPersonFilter): AuditEventKey[] | null {
  switch (filter) {
    case 'all':
      return null;
    case 'logins':
      return byPrefix('auth.login', 'auth.logout', 'auth.logout_all', 'audit.lockout_summary', 'detect.otp_fatigue');
    case 'devices':
      return [...byPrefix('auth.session'), ...byPrefix('account.device_forgotten', 'account.device_renamed')];
    case 'credentials':
      return byPrefix('auth.password', 'auth.phone', 'auth.otp', 'auth.step_up', 'account');
    case 'orgs':
      return byPrefix('org');
    case 'keys':
      return byPrefix('keys', 'account.integration');
    case 'data':
      return byPrefix('pd', 'consents', 'data', 'sharing', 'files');
    case 'reveals':
      // Кто раскрывал МОИ защищённые поля (core/visibility)
      return byPrefix('pii.reveal', 'pii.reveal_denied');
  }
}

/** Ключи чипа журнала организации (`all` → null). */
export function auditOrgFilterKeys(filter: AuditOrgFilter): AuditEventKey[] | null {
  switch (filter) {
    case 'all':
      return null;
    case 'people':
      return byPrefix('org.member', 'org.role', 'org.ownership', 'org.workspace');
    case 'devices':
      return byPrefix('org.session');
    case 'sharing':
      return byPrefix('sharing');
    case 'keys':
      return [...byPrefix('keys'), ...byPrefix('org.audit')];
    case 'exports':
      return byPrefix('data', 'pii', 'detect.mass_export');
    case 'files':
      return byPrefix('files');
    case 'consents':
      return byPrefix('consents', 'pd');
    case 'reveals':
      // Раскрытия защищённых полей, тревоги и правила видимости (core/visibility)
      return [...byPrefix('pii.reveal', 'pii.reveal_denied', 'detect.mass_reveal', 'detect.pii_scrape'), ...byPrefix('org.visibility')];
  }
}

/**
 * Самопроверка реестра — зовётся смоуком бутстрапа API (громкий отказ старта) и
 * повторяет правила стража `check:audit` на собранном коде.
 */
export function auditRegistryProblems(): string[] {
  const problems: string[] = [];
  const deny = new Set<string>(AUDIT_DENY_DETAIL_WORDS);
  const categories = new Set<string>(AUDIT_CATEGORIES);
  for (const key of AUDIT_EVENT_KEYS) {
    const def = AUDIT_REGISTRY[key];
    if (!/^[a-z]+(\.[a-z_]+){1,2}$/.test(key)) problems.push(`${key}: key must be <category>.<object>[.<action>] in snake_case`);
    if (!categories.has(def.category)) problems.push(`${key}: unknown category "${def.category}"`);
    if (auditCategoryOfKey(key) !== def.category) problems.push(`${key}: category "${def.category}" must equal the key prefix "${auditCategoryOfKey(key)}"`);
    if (def.visibility.platform !== true) problems.push(`${key}: visibility.platform must be true — the platform sees every event`);
    if (def.category === 'platform' && (def.visibility.subject || def.visibility.workspace)) {
      problems.push(`${key}: platform staff actions are never shown to people or organizations`);
    }
    if (def.windowExempt && def.category !== 'pd' && def.category !== 'consents') problems.push(`${key}: windowExempt is only for pd and consents`);
    if (def.category === 'authz' && (def.visibility.subject || def.visibility.workspace)) {
      problems.push(`${key}: access denials are platform-only — showing them would reveal that a foreign object exists`);
    }
    if (def.disputable && !def.visibility.subject) problems.push(`${key}: a disputable event must be visible to its subject`);
    if (def.details._def.unknownKeys !== 'strict') problems.push(`${key}: details schema must be .strict()`);
    if (def.vocab !== undefined && !isAuditVocab(def.vocab)) problems.push(`${key}: unknown OWASP vocabulary "${def.vocab}"`);
    const names = Object.keys(def.details.shape);
    if (names.length > AUDIT_LIMITS.maxDetailKeys) problems.push(`${key}: more than ${AUDIT_LIMITS.maxDetailKeys} details`);
    for (const name of names) {
      const bad = auditDetailWords(name).find((w) => deny.has(w));
      if (bad) problems.push(`${key}: detail "${name}" contains a denied word "${bad}"`);
    }
  }
  if (AUDIT_EVENT_KEYS.length > AUDIT_LIMITS.maxKeys) problems.push(`registry: ${AUDIT_EVENT_KEYS.length} keys exceed the ceiling ${AUDIT_LIMITS.maxKeys}`);
  return problems;
}
