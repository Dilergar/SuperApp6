import type { ANALYTICS_LIMITS, AnalyticsClientEventKey, AnalyticsPropsOf } from '@superapp/shared';
import type { AnalyticsStorageAdapter } from './storage';

export * from './storage';

// ============================================================
// @superapp/analytics — клиентский SDK движка core/analytics
// ============================================================
// Без runtime-зависимостей: лимиты и признаки событий реестра (анонимность, выборка)
// ВНЕДРЯЮТСЯ конфигом из @superapp/shared — второго источника правды нет, а SDK не
// тянет zod. Отказ SDK никогда не всплывает в интерфейс: любые ошибки глотаются.
//
// Транспорт — единственное разрешённое исключение из правила «клиент ходит в API
// только хелперами @superapp/api-client» (docs/contract_boundary.md): очередь должна
// уметь `fetch(keepalive)` на выгрузке страницы, а axios этого не умеет.

type Limits = Pick<
  typeof ANALYTICS_LIMITS,
  | 'maxBatch'
  | 'maxBatchBytes'
  | 'anonMaxBodyBytes'
  | 'sessionIdleMs'
  | 'sessionMaxMs'
  | 'flushEvents'
  | 'flushIntervalMs'
  | 'offlineMaxEvents'
  | 'offlineMaxBytes'
  | 'offlineMaxAgeMs'
>;

/** Признаки события из реестра, нужные клиенту. */
export interface AnalyticsEventTraits {
  anonymous?: boolean;
  sample?: number;
}

export interface AnalyticsSdkConfig {
  /** База API, включая версию: `…/api/v1` */
  baseURL: string;
  /** Access-токен продукта (нет — события уходят анонимной ручкой) */
  getToken: () => string | null | Promise<string | null>;
  /** Организация текущего экрана → `X-Workspace-Id` (членство проверит сервер) */
  getWorkspaceId?: () => string | null;
  getLocale?: () => string | null | undefined;
  /** Шаблон маршрута текущего экрана (`/tasks/:id`) — «где это случилось»; сервер перешаблонит сам */
  getRoute?: () => string | null;
  storage: AnalyticsStorageAdapter;
  app: { platform: 'web' | 'ios' | 'android'; version?: string };
  limits: Limits;
  /** Признаки ключа реестра; `undefined` — ключа нет, событие не отправляется */
  traits: (key: string) => AnalyticsEventTraits | undefined;
  fetchImpl?: typeof fetch;
}

export interface AnalyticsClient {
  /** Событие «увидел / попытался». Ключ и свойства проверяет компилятор по реестру. */
  track<K extends AnalyticsClientEventKey>(key: K, props: AnalyticsPropsOf<K>): void;
  /** Связать анонимный id устройства с вошедшим аккаунтом (после входа/регистрации) */
  identify(): Promise<void>;
  /** Выход: новый анонимный id и сессия, очередь прежнего аккаунта сбрасывается */
  reset(): void;
  /** Локальный отказ (сервер применяет свой независимо) */
  setOptOut(optOut: boolean): void;
  flush(opts?: { unload?: boolean }): Promise<void>;
  /** Сессия и устройство для заголовков `X-Analytics-*` серверных событий */
  context(): { sessionId: string; deviceId: string } | null;
}

interface Session {
  id: string;
  startedAt: number;
  lastAt: number;
}

interface QueuedEvent {
  eventId: string;
  key: string;
  occurredAt: string;
  props: Record<string, unknown>;
  sessionId: string;
  deviceId: string;
  anonymousId: string;
  workspaceId: string | null;
  route?: string;
  sampleRate?: number;
  /** Можно ли слать без токена (признак реестра на момент события) */
  anon: boolean;
  /** Время постановки, мс — для офлайн-потолка по возрасту */
  at: number;
}

const KEYS = {
  device: 'sa6.analytics.device',
  anon: 'sa6.analytics.anon',
  session: 'sa6.analytics.session',
  queue: 'sa6.analytics.queue',
  optOut: 'sa6.analytics.optout',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const MAX_BACKOFF_MS = 5 * 60_000;

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Длина строки в байтах UTF-8 без аллокаций. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
  }
  return n;
}

const isPromise = <T>(v: T | Promise<T>): v is Promise<T> => !!v && typeof (v as Promise<T>).then === 'function';

export function createAnalytics(config: AnalyticsSdkConfig): AnalyticsClient {
  const { limits, storage } = config;
  const browser = typeof window !== 'undefined';
  const fetchImpl = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);

  let deviceId = '';
  let anonymousId = '';
  let session: Session | null = null;
  let optOut = false;
  let queue: QueuedEvent[] = [];
  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let retryAt = 0;
  let backoff = 0;

  const gpc = () => browser && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  function adopt(values: { device: string | null; anon: string | null; session: string | null; queue: string | null; optOut: string | null }) {
    deviceId = isUuid(values.device) ? values.device : uuid();
    anonymousId = isUuid(values.anon) ? values.anon : uuid();
    if (values.device !== deviceId) safe(() => storage.set(KEYS.device, deviceId));
    if (values.anon !== anonymousId) safe(() => storage.set(KEYS.anon, anonymousId));
    const s = safe(() => JSON.parse(values.session ?? 'null') as Session | null);
    session = s && isUuid(s.id) && typeof s.startedAt === 'number' && typeof s.lastAt === 'number' ? s : null;
    optOut = values.optOut === '1';
    const saved = safe(() => JSON.parse(values.queue ?? '[]') as QueuedEvent[]);
    if (Array.isArray(saved)) queue = prune([...saved.filter((e) => e && isUuid(e.eventId) && typeof e.key === 'string'), ...queue]);
    initialized = true;
    if (browser) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flush({ unload: true });
      });
      window.addEventListener('pagehide', () => void flush({ unload: true }));
      window.addEventListener('online', () => {
        retryAt = 0;
        void flush();
      });
    }
    if (queue.length) schedule(false);
  }

  /** Синхронный старт, если хранилище синхронное (веб); иначе — асинхронный. */
  function init(): Promise<void> {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    const raw = [KEYS.device, KEYS.anon, KEYS.session, KEYS.queue, KEYS.optOut].map((k) => safe(() => storage.get(k)) ?? null);
    if (!raw.some(isPromise)) {
      const [device, anon, sess, q, o] = raw as Array<string | null>;
      adopt({ device, anon, session: sess, queue: q, optOut: o });
      return Promise.resolve();
    }
    initPromise = Promise.all(raw.map((v) => Promise.resolve(v).catch(() => null)))
      .then(([device, anon, sess, q, o]) => adopt({ device, anon, session: sess, queue: q, optOut: o }))
      .catch(() => adopt({ device: null, anon: null, session: null, queue: null, optOut: null }));
    return initPromise;
  }

  function prune(list: QueuedEvent[]): QueuedEvent[] {
    const now = Date.now();
    let out = list.filter((e) => now - (e.at ?? 0) <= limits.offlineMaxAgeMs);
    if (out.length > limits.offlineMaxEvents) out = out.slice(out.length - limits.offlineMaxEvents);
    return out;
  }

  function persist(immediate: boolean) {
    const write = () => {
      persistTimer = null;
      let list = queue;
      let json = safe(() => JSON.stringify(list)) ?? '[]';
      while (list.length && utf8Bytes(json) > limits.offlineMaxBytes) {
        list = list.slice(Math.ceil(list.length / 4));
        json = safe(() => JSON.stringify(list)) ?? '[]';
      }
      safe(() => storage.set(KEYS.queue, json));
      if (session) safe(() => storage.set(KEYS.session, JSON.stringify(session)));
    };
    if (immediate) return write();
    if (!persistTimer) persistTimer = setTimeout(write, 250);
  }

  function touchSession(now: number): Session {
    if (!session || now - session.lastAt > limits.sessionIdleMs || now - session.startedAt > limits.sessionMaxMs) {
      session = { id: uuid(), startedAt: now, lastAt: now };
    } else {
      session.lastAt = now;
    }
    return session;
  }

  function schedule(now: boolean) {
    if (now) {
      if (timer) clearTimeout(timer);
      timer = null;
      const idle = browser ? (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback : undefined;
      if (idle) idle(() => void flush(), { timeout: 2000 });
      else setTimeout(() => void flush(), 0);
      return;
    }
    if (!timer) timer = setTimeout(() => {
      timer = null;
      void flush();
    }, limits.flushIntervalMs);
  }

  function enqueue(key: string, props: Record<string, unknown>, occurredAt: string) {
    if (optOut || gpc()) return;
    const traits = config.traits(key);
    if (!traits) return;
    const sample = traits.sample;
    if (sample !== undefined && sample < 1 && Math.random() >= sample) return;
    const s = touchSession(Date.now());
    const route = safe(() => config.getRoute?.() ?? null) ?? null;
    queue.push({
      ...(route ? { route: route.slice(0, 256) } : {}),
      eventId: uuid(),
      key,
      occurredAt,
      props,
      sessionId: s.id,
      deviceId,
      anonymousId,
      workspaceId: safe(() => config.getWorkspaceId?.() ?? null) ?? null,
      ...(sample !== undefined && sample < 1 ? { sampleRate: sample } : {}),
      anon: traits.anonymous === true,
      at: Date.now(),
    });
    queue = prune(queue);
    persist(false);
    schedule(queue.length >= limits.flushEvents);
  }

  /** Батчи группы: ≤ maxBatch событий и ≤ потолка байтов (тело с обёрткой). */
  function batches(events: QueuedEvent[], maxBytes: number): QueuedEvent[][] {
    const out: QueuedEvent[][] = [];
    let cur: QueuedEvent[] = [];
    let bytes = 256;
    for (const e of events) {
      const size = utf8Bytes(JSON.stringify(wire(e))) + 1;
      if (cur.length && (cur.length >= limits.maxBatch || bytes + size > maxBytes)) {
        out.push(cur);
        cur = [];
        bytes = 256;
      }
      if (size + 256 > maxBytes) continue; // одно событие больше потолка — не отправляется
      cur.push(e);
      bytes += size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function wire(e: QueuedEvent) {
    return {
      eventId: e.eventId,
      key: e.key,
      occurredAt: e.occurredAt,
      props: e.props,
      sessionId: e.sessionId,
      deviceId: e.deviceId,
      anonymousId: e.anonymousId,
      ...(e.route ? { route: e.route } : {}),
      ...(e.sampleRate !== undefined ? { sampleRate: e.sampleRate } : {}),
    };
  }

  async function send(batch: QueuedEvent[], token: string | null, unload: boolean): Promise<'ok' | 'drop' | 'retry'> {
    if (!fetchImpl) return 'retry';
    const workspaceId = batch[0]?.workspaceId ?? null;
    const body = JSON.stringify({
      sentAt: new Date().toISOString(),
      app: config.app.version ? config.app : { platform: config.app.platform },
      context: {
        ...(safe(() => config.getLocale?.()) ? { locale: config.getLocale!()! } : {}),
        ...(safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ? { tz: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      },
      batch: batch.map(wire),
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (token && workspaceId) headers['X-Workspace-Id'] = workspaceId;
    try {
      const res = await fetchImpl(`${config.baseURL}/analytics/${token ? 'collect' : 'collect/anon'}`, {
        method: 'POST',
        headers,
        body,
        credentials: 'omit',
        keepalive: unload,
      });
      if (res.ok) return 'ok';
      // Батч не годится (форма, размер) — повтор не поможет
      if (res.status === 400 || res.status === 413) return 'drop';
      return 'retry';
    } catch {
      return 'retry';
    }
  }

  async function doFlush(unload: boolean): Promise<void> {
    if (!initialized) await init();
    if (!queue.length) return;
    if (!unload && Date.now() < retryAt) return;
    const token = (await Promise.resolve(safe(() => config.getToken())).catch(() => null)) ?? null;
    const eligible = token ? queue : queue.filter((e) => e.anon);
    if (!eligible.length) return;
    // Заголовок организации — на батч: группируем по контексту события
    const groups = new Map<string, QueuedEvent[]>();
    for (const e of eligible) {
      const g = token && e.workspaceId ? e.workspaceId : '';
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    const maxBytes = token ? limits.maxBatchBytes : Math.min(limits.maxBatchBytes, limits.anonMaxBodyBytes);
    const done = new Set<string>();
    let failed = false;
    for (const group of groups.values()) {
      for (const batch of batches(group, maxBytes)) {
        const r = await send(batch, token, unload);
        if (r === 'retry') {
          failed = true;
          break;
        }
        for (const e of batch) done.add(e.eventId);
      }
      if (failed) break;
    }
    if (done.size) queue = queue.filter((e) => !done.has(e.eventId));
    if (failed) {
      backoff = Math.min(backoff ? backoff * 2 : limits.flushIntervalMs, MAX_BACKOFF_MS);
      retryAt = Date.now() + backoff;
    } else {
      backoff = 0;
      retryAt = 0;
    }
    persist(unload);
    if (!failed && queue.length && !unload) schedule(false);
  }

  function flush(opts?: { unload?: boolean }): Promise<void> {
    if (flushing && !opts?.unload) return flushing;
    const run = doFlush(!!opts?.unload).catch(() => undefined);
    flushing = run.finally(() => {
      if (flushing === run) flushing = null;
    });
    return run;
  }

  return {
    track(key, props) {
      if (!browser && !config.fetchImpl) return;
      const occurredAt = new Date().toISOString();
      const p = (props ?? {}) as Record<string, unknown>;
      if (initialized) return enqueue(key, p, occurredAt);
      void init().then(() => enqueue(key, p, occurredAt));
    },

    async identify() {
      try {
        await init();
        const token = await Promise.resolve(config.getToken());
        if (!token || !fetchImpl) return;
        await fetchImpl(`${config.baseURL}/analytics/identify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ anonymousId }),
          credentials: 'omit',
        });
        void flush();
      } catch {
        /* склейка — не повод ломать вход */
      }
    },

    reset() {
      safe(() => {
        void init().then(() => {
          anonymousId = uuid();
          session = null;
          queue = [];
          safe(() => storage.set(KEYS.anon, anonymousId));
          safe(() => storage.remove(KEYS.session));
          persist(true);
        });
      });
    },

    setOptOut(value) {
      void init().then(() => {
        optOut = value;
        safe(() => storage.set(KEYS.optOut, value ? '1' : '0'));
        if (value) {
          queue = [];
          persist(true);
        }
      });
    },

    flush,

    context() {
      if (!initialized) {
        void init();
        if (!initialized) return null;
      }
      if (optOut || gpc() || !session) return null;
      // Только ЧТЕНИЕ: фоновые запросы (поллинг, рефетчи) не продлевают сессию —
      // её живость задают действия человека (track)
      const now = Date.now();
      if (now - session.lastAt > limits.sessionIdleMs || now - session.startedAt > limits.sessionMaxMs) return null;
      return { sessionId: session.id, deviceId };
    },
  };
}
