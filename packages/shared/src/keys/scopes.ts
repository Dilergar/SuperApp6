import type { KeyScopeLevel } from './types';

// ============================================================
// core/keys — реестр скоупов: префикс маршрута → сервис (плоские `<service>:read|write`)
// ============================================================
// Право ключа = скоуп ∩ права носителя в core/access ∩ организация. Скоуп
// решает «в какой сервис пускать», права носителя — «что именно можно». Метод
// запроса даёт уровень: GET/HEAD → read, остальное → write; write ⊇ read.
// Сервис вне реестра или маршрут с `@NoApiKeys()` — 403 `keys.scope.denied`
// (deny-by-default). Новый сервис, открытый ключам, = +1 строка здесь.
//
// Реестр — ЯВНЫЙ белый список, catch-all по `/workspaces` запрещён: маршрут
// организации, не перечисленный здесь и не помеченный `@NoApiKeys()`, роняет бут
// (`KeysRoutesAudit`), чтобы новый контроллер под `/workspaces/:id/…` не открылся
// ботам молча. Шаблон с `$` на конце совпадает ТОЛЬКО с этим путём (без вложенных):
// `/workspaces/:id$` — карточка организации, но не `/workspaces/:id/requisites`.

export interface KeyScopeServiceDef {
  /** Шаблоны префиксов маршрутов (`:id` — любой uuid-сегмент; `$` на конце — точное совпадение). Длинные — раньше коротких. */
  prefixes: readonly string[];
  /** Открыт ли ботам (первая волна). Остальные — только личным ключам (права человека). */
  bot: boolean;
  /** Потолок уровня для бота (`staff`/`drive` — только чтение) */
  botMax?: KeyScopeLevel;
  /** Порядок в матрице прав */
  order: number;
}

export const KEY_SCOPE_SERVICES = {
  tasks: { prefixes: ['/tasks'], bot: true, order: 10 },
  calendar: { prefixes: ['/calendar', '/resources'], bot: true, order: 20 },
  notes: { prefixes: ['/notes'], bot: true, order: 30 },
  drive: { prefixes: ['/drive'], bot: true, botMax: 'read', order: 40 },
  files: { prefixes: ['/files'], bot: true, order: 45 },
  documents: {
    prefixes: ['/workspaces/:id/documents', '/workspaces/:id/doc-campaigns', '/doc-campaigns', '/docs'],
    bot: true,
    order: 50,
  },
  counterparties: { prefixes: ['/workspaces/:id/counterparties', '/workspaces/:id/legal-entities'], bot: true, order: 60 },
  // Объекты — вся вертикаль: дерево площадок, штат и ставки, смены и явка, оборудование
  objects: {
    prefixes: [
      '/workspaces/:id/objects',
      '/workspaces/:id/staffing',
      '/workspaces/:id/shift-templates',
      '/workspaces/:id/shift-patterns',
      '/workspaces/:id/shifts',
      '/workspaces/:id/attendance',
      '/workspaces/:id/asset-models',
      '/workspaces/:id/assets',
    ],
    bot: true,
    order: 70,
  },
  staff: { prefixes: ['/workspaces/:id/staff', '/workspaces/:id/org'], bot: true, botMax: 'read', order: 80 },
  search: { prefixes: ['/search'], bot: true, botMax: 'read', order: 85 },
  // Организация: список, карточка, ростер, журнал — ровно эти пути (точные `$`),
  // без catch-all: реквизиты и приглашения — отдельные сервисы ниже.
  workspaces: {
    prefixes: ['/workspaces$', '/workspaces/archived$', '/workspaces/:id$', '/workspaces/:id/members', '/workspaces/:id/journal'],
    bot: true,
    botMax: 'read',
    order: 90,
  },
  chatter: { prefixes: ['/chatter'], bot: true, botMax: 'read', order: 95 },
  // Только личные ключи (права человека): сервисы «между людьми»
  // Реквизиты и банковские счета организации (IBAN) — только личный ключ owner/admin
  requisites: { prefixes: ['/workspaces/:id/requisites'], bot: false, order: 100 },
  // Приглашения в организацию (номера телефонов) — только личный ключ
  invitations: { prefixes: ['/workspaces/:id/invitations', '/workspaces/invitations'], bot: false, order: 105 },
  messenger: { prefixes: ['/messenger'], bot: false, order: 110 },
  circles: { prefixes: ['/circles', '/contacts'], bot: false, order: 120 },
  finance: { prefixes: ['/finance'], bot: false, order: 130 },
  shop: { prefixes: ['/shop'], bot: false, order: 140 },
  approvals: { prefixes: ['/approvals'], bot: false, order: 150 },
  sign: { prefixes: ['/sign'], bot: false, order: 160 },
  hr: { prefixes: ['/workspaces/:id/hr', '/hr'], bot: false, order: 170 },
  processes: { prefixes: ['/workspaces/:id/processes'], bot: false, order: 180 },
  office: { prefixes: ['/workspaces/:id/office'], bot: false, order: 190 },
  recorder: { prefixes: ['/recorder', '/voice'], bot: false, order: 200 },
  share: { prefixes: ['/share-links', '/workspaces/:id/share-links'], bot: false, order: 210 },
} as const satisfies Record<string, KeyScopeServiceDef>;

export type KeyScopeService = keyof typeof KEY_SCOPE_SERVICES;
export const KEY_SCOPE_SERVICE_KEYS = Object.keys(KEY_SCOPE_SERVICES) as KeyScopeService[];

/** Скоупы ключа: сервис → уровень; отсутствие = нет доступа. */
export type KeyScopes = Partial<Record<KeyScopeService, KeyScopeLevel>>;

export function isKeyScopeService(value: unknown): value is KeyScopeService {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KEY_SCOPE_SERVICES, value);
}

/** Сервисы, открытые ботам, в порядке матрицы. */
export function botScopeServices(): KeyScopeService[] {
  return KEY_SCOPE_SERVICE_KEYS.filter((k) => KEY_SCOPE_SERVICES[k].bot).sort(
    (a, b) => KEY_SCOPE_SERVICES[a].order - KEY_SCOPE_SERVICES[b].order,
  );
}

/** Все сервисы реестра в порядке матрицы (личный ключ). */
export function allScopeServices(): KeyScopeService[] {
  return [...KEY_SCOPE_SERVICE_KEYS].sort((a, b) => KEY_SCOPE_SERVICES[a].order - KEY_SCOPE_SERVICES[b].order);
}

const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Совпадает ли путь запроса (без `/api/v1`) с шаблоном. Шаблон — префикс; с `$`
 * на конце — точное совпадение по числу сегментов (`/workspaces/:id$` не ловит
 * `/workspaces/:id/requisites`).
 */
export function keyPrefixMatches(pattern: string, pathname: string): boolean {
  const exact = pattern.endsWith('$');
  const p = (exact ? pattern.slice(0, -1) : pattern).split('/').filter(Boolean);
  const s = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (s.length < p.length) return false;
  if (exact && s.length !== p.length) return false;
  for (let i = 0; i < p.length; i++) {
    const want = p[i]!;
    const got = s[i]!;
    if (want === ':id') {
      if (!uuidLike.test(got)) return false;
      continue;
    }
    if (want !== got.toLowerCase()) return false;
  }
  return true;
}

/**
 * Сервис по пути запроса: длинный шаблон побеждает короткий
 * (`/workspaces/:id/objects` раньше `/workspaces`). `null` — сервис не открыт ключам.
 */
export function keyScopeServiceOf(pathname: string): KeyScopeService | null {
  let best: { service: KeyScopeService; len: number } | null = null;
  for (const service of KEY_SCOPE_SERVICE_KEYS) {
    for (const pattern of KEY_SCOPE_SERVICES[service].prefixes) {
      if (!keyPrefixMatches(pattern, pathname)) continue;
      const len = pattern.split('/').filter(Boolean).length;
      if (!best || len > best.len) best = { service, len };
    }
  }
  return best?.service ?? null;
}

/** Уровень, который требует HTTP-метод. */
export function keyScopeLevelOf(method: string): KeyScopeLevel {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}

/** Достаточен ли уровень скоупа (`write` ⊇ `read`). */
export function keyScopeSatisfies(granted: KeyScopeLevel | undefined, required: KeyScopeLevel): boolean {
  if (!granted) return false;
  return granted === 'write' || required === 'read';
}

/**
 * Нормализация скоупов при создании: неизвестные сервисы отбрасываются, потолок
 * бота (`botMax`) и закрытые ботам сервисы срезаются молча — сервер не выдаёт
 * то, чего у носителя быть не может.
 */
export function normalizeKeyScopes(input: Record<string, unknown> | null | undefined, forBot: boolean): KeyScopes {
  const out: KeyScopes = {};
  if (!input) return out;
  for (const [service, level] of Object.entries(input)) {
    if (!isKeyScopeService(service)) continue;
    if (level !== 'read' && level !== 'write') continue;
    const def = KEY_SCOPE_SERVICES[service] as KeyScopeServiceDef;
    if (forBot) {
      if (!def.bot) continue;
      if (def.botMax === 'read' && level === 'write') {
        out[service] = 'read';
        continue;
      }
    }
    out[service] = level;
  }
  return out;
}
