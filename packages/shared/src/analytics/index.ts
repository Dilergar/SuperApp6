// ============================================================
// core/analytics — единый реестр событий (сливается из файлов сервисов)
// ============================================================
// Новый сервис = +1 файл `<service>.ts` + `analytics.events.<key>.title|description`
// в трёх каталогах. Union `AnalyticsEventKey` ВЫВОДИТСЯ из реестра, руками не пишется;
// страж `pnpm check:analytics` сверяет реестр с каталогами, запрещённые имена свойств,
// владельца ключа и то, что серверные ключи не зовутся из клиентов.

import type { z } from 'zod';
import {
  ANALYTICS_AREAS,
  ANALYTICS_DENY_PROP_WORDS,
  ANALYTICS_LIMITS,
  analyticsPropWords,
  type AnalyticsAreaKey,
  type AnalyticsEventDef,
} from './types';
import { PLATFORM_ANALYTICS_EVENTS } from './platform';
import { TASKS_ANALYTICS_EVENTS } from './tasks';
import { MESSENGER_ANALYTICS_EVENTS } from './messenger';
import { CALENDAR_ANALYTICS_EVENTS } from './calendar';
import { KEYS_ANALYTICS_EVENTS } from './keys';
import { CONSENTS_ANALYTICS_EVENTS } from './consents';
import { AUDIT_ANALYTICS_EVENTS } from './audit';

export * from './types';
export * from './routes';

const REGISTRY_RAW = {
  ...PLATFORM_ANALYTICS_EVENTS,
  ...TASKS_ANALYTICS_EVENTS,
  ...MESSENGER_ANALYTICS_EVENTS,
  ...CALENDAR_ANALYTICS_EVENTS,
  ...KEYS_ANALYTICS_EVENTS,
  ...CONSENTS_ANALYTICS_EVENTS,
  ...AUDIT_ANALYTICS_EVENTS,
} as const satisfies Record<string, AnalyticsEventDef>;

/** Union ключей — выводится из реестра. Ключ вне реестра в `track()` — ошибка компиляции. */
export type AnalyticsEventKey = keyof typeof REGISTRY_RAW;

/** Свойства события — ровно то, что разрешает его схема. */
export type AnalyticsPropsOf<K extends AnalyticsEventKey> = z.infer<(typeof REGISTRY_RAW)[K]['props']>;

/** Ключи, которые вправе прислать клиент (для типов SDK). */
export type AnalyticsClientEventKey = {
  [K in AnalyticsEventKey]: (typeof REGISTRY_RAW)[K]['source'] extends 'server' ? never : K;
}[AnalyticsEventKey];

/** Ключи серверных фактов (для типов `AnalyticsService.track`). */
export type AnalyticsServerEventKey = {
  [K in AnalyticsEventKey]: (typeof REGISTRY_RAW)[K]['source'] extends 'client' ? never : K;
}[AnalyticsEventKey];

export const ANALYTICS_REGISTRY: Readonly<Record<AnalyticsEventKey, AnalyticsEventDef>> = REGISTRY_RAW;
export const ANALYTICS_EVENT_KEYS = Object.keys(ANALYTICS_REGISTRY) as AnalyticsEventKey[];

export function isAnalyticsEventKey(value: unknown): value is AnalyticsEventKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ANALYTICS_REGISTRY, value);
}

/** Декларация события; для ключа вне реестра — undefined. */
export function analyticsEventDef(key: string): AnalyticsEventDef | undefined {
  return isAnalyticsEventKey(key) ? ANALYTICS_REGISTRY[key] : undefined;
}

/** События области в порядке реестра. */
export function analyticsEventsOf(service: AnalyticsAreaKey): AnalyticsEventKey[] {
  return ANALYTICS_EVENT_KEYS.filter((k) => ANALYTICS_REGISTRY[k].service === service);
}

/** Ключи квалифицирующих событий (активность). */
export const ANALYTICS_QUALIFYING_KEYS = ANALYTICS_EVENT_KEYS.filter((k) => ANALYTICS_REGISTRY[k].qualifying);

/**
 * Enum-свойства события для фильтра шага воронки (конструктор предлагает только их:
 * свободные строки и числа фильтром не становятся).
 */
export function analyticsEnumPropsOf(key: AnalyticsEventKey): Array<{ prop: string; values: string[] }> {
  const shape = ANALYTICS_REGISTRY[key].props.shape as Record<string, z.ZodTypeAny>;
  const out: Array<{ prop: string; values: string[] }> = [];
  for (const [prop, schema] of Object.entries(shape)) {
    let s: z.ZodTypeAny = schema;
    while (s._def?.innerType) s = s._def.innerType as z.ZodTypeAny;
    if (s._def?.typeName === 'ZodEnum') out.push({ prop, values: [...(s._def.values as string[])] });
    else if (s._def?.typeName === 'ZodBoolean') out.push({ prop, values: ['true', 'false'] });
  }
  return out;
}

/**
 * Самопроверка реестра — зовётся смоуком бутстрапа API (громкий отказ старта) и
 * повторяет правила стража `check:analytics` на собранном коде.
 */
export function analyticsRegistryProblems(): string[] {
  const problems: string[] = [];
  const deny = new Set<string>(ANALYTICS_DENY_PROP_WORDS);
  let live = 0;
  for (const key of ANALYTICS_EVENT_KEYS) {
    const def = ANALYTICS_REGISTRY[key];
    if (!/^[a-z]+\.[a-z_]+\.[a-z_]+$/.test(key)) problems.push(`${key}: key must be <service>.<object>.<action>`);
    if (key.split('.')[0] !== def.service) problems.push(`${key}: service "${def.service}" must equal the first key segment`);
    if (!Object.prototype.hasOwnProperty.call(ANALYTICS_AREAS, def.service)) problems.push(`${key}: unknown area "${def.service}"`);
    if (def.anonymous && def.source === 'server') problems.push(`${key}: a server key cannot be anonymous`);
    if (def.sample !== undefined && !(def.sample > 0 && def.sample <= 1)) problems.push(`${key}: sample must be in (0, 1]`);
    if (def.props._def.unknownKeys !== 'strict') problems.push(`${key}: props schema must be .strict()`);
    const names = Object.keys(def.props.shape);
    if (names.length > ANALYTICS_LIMITS.maxPropKeys) problems.push(`${key}: more than ${ANALYTICS_LIMITS.maxPropKeys} props`);
    for (const name of names) {
      const bad = analyticsPropWords(name).find((w) => deny.has(w));
      if (bad) problems.push(`${key}: prop "${name}" contains a denied word "${bad}"`);
    }
    if (def.status === 'live') live++;
  }
  if (live > ANALYTICS_LIMITS.maxLiveKeys) problems.push(`registry: ${live} live keys exceed the ceiling ${ANALYTICS_LIMITS.maxLiveKeys}`);
  return problems;
}

// ---- Редакция значений (PII-скан на приёме) ----

const PHONE_RE = /(?:\+7|\b8)\s?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/;
const IIN_RE = /\b\d{12}\b/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
export const ANALYTICS_REDACTED = '[redacted]';

/** Похоже ли значение на персональные данные (телефон РК, 12 цифр ИИН/БИН, e-mail). */
export function analyticsLooksLikePii(value: string): boolean {
  return PHONE_RE.test(value) || IIN_RE.test(value) || EMAIL_RE.test(value);
}
