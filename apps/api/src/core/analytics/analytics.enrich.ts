import {
  ANALYTICS_AREAS,
  ANALYTICS_DEVICE_CLASSES,
  ANALYTICS_LIMITS,
  ANALYTICS_REDACTED,
  analyticsLooksLikePii,
  routeTemplateOf,
  serviceOfRoute,
  type AnalyticsDeviceClass,
} from '@superapp/shared';

// ============================================================
// Чистые функции приёма: UA → грубые признаки, клампинг времени, форма, редакция
// ============================================================

const DEVICE_CODE = Object.fromEntries(ANALYTICS_DEVICE_CLASSES.map((c, i) => [c, i])) as Record<AnalyticsDeviceClass, number>;

/**
 * User-Agent → класс устройства, семейство ОС и браузера. Грубо и намеренно: версия,
 * сборка и модель — это отпечаток устройства, а не аналитика. Сам UA не хранится.
 */
export function parseUserAgent(ua: string | null | undefined): { deviceClass: number | null; os: string | null; browser: string | null } {
  if (!ua) return { deviceClass: null, os: null, browser: null };
  const s = ua.slice(0, 512);
  const bot = /bot|crawl|spider|headless|lighthouse/i.test(s);
  const tablet = /ipad|tablet|(android(?!.*mobile))/i.test(s);
  const mobile = /mobi|iphone|ipod|android/i.test(s);
  const deviceClass = DEVICE_CODE[bot ? 'other' : tablet ? 'tablet' : mobile ? 'mobile' : 'desktop'];
  const os = /windows/i.test(s)
    ? 'windows'
    : /iphone|ipad|ipod|ios/i.test(s)
      ? 'ios'
      : /android/i.test(s)
        ? 'android'
        : /mac os|macintosh/i.test(s)
          ? 'macos'
          : /linux|x11/i.test(s)
            ? 'linux'
            : 'other';
  const browser = /edg\//i.test(s)
    ? 'edge'
    : /opr\/|opera/i.test(s)
      ? 'opera'
      : /yabrowser/i.test(s)
        ? 'yandex'
        : /firefox|fxios/i.test(s)
          ? 'firefox'
          : /chrome|crios|chromium/i.test(s)
            ? 'chrome'
            : /safari/i.test(s)
              ? 'safari'
              : 'other';
  return { deviceClass, os, browser };
}

/** Клампинг времени клиента в окно `[received − 7 д, received + 1 ч]`. */
export function clampEventTime(occurredAt: string, receivedAt: Date): { ts: Date; corrected: boolean } {
  const t = Date.parse(occurredAt);
  const lo = receivedAt.getTime() - ANALYTICS_LIMITS.clockSkewPastMs;
  const hi = receivedAt.getTime() + ANALYTICS_LIMITS.clockSkewFutureMs;
  if (!Number.isFinite(t)) return { ts: receivedAt, corrected: true };
  if (t < lo) return { ts: new Date(lo), corrected: true };
  if (t > hi) return { ts: new Date(hi), corrected: true };
  return { ts: new Date(t), corrected: false };
}

/** Форма объекта для карантина: только имена и типы полей (значения не покидают приём). */
export function shapeOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let n = 0;
  for (const k of Object.keys(value)) {
    if (n++ >= 24) break;
    const v = (value as Record<string, unknown>)[k];
    out[sanitizeKey(k, 64)] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }
  return out;
}

/** Ключ из недоверенного ввода — в безопасный вид для карантина и логов. */
export function sanitizeKey(raw: unknown, max = 100): string {
  if (typeof raw !== 'string' || !raw) return '(missing)';
  return raw.slice(0, max).replace(/[^A-Za-z0-9_.:-]/g, '?');
}

/** Редакция строковых значений, похожих на персональные данные. */
export function redactProps(props: Record<string, unknown>): { props: Record<string, unknown>; redacted: number } {
  let redacted = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string' && analyticsLooksLikePii(v)) {
      out[k] = ANALYTICS_REDACTED;
      redacted++;
    } else {
      out[k] = v;
    }
  }
  return { props: out, redacted };
}

/**
 * Шаблон маршрута СЕРВЕРОМ: клиент мог прислать адрес с id — повторный проход
 * `routeTemplateOf` вырезает их независимо от честности SDK.
 */
export function templateRoute(route: unknown): string | null {
  if (typeof route !== 'string' || !route.startsWith('/')) return null;
  return routeTemplateOf(route);
}

/** Для `navigation.page.viewed` сервер пересобирает `route`/`service` из шаблона. */
export function normalizePageProps(props: Record<string, unknown>): Record<string, unknown> {
  const route = templateRoute(props.route) ?? '/';
  const referrer = templateRoute(props.referrerRoute);
  const service = serviceOfRoute(route);
  return {
    route,
    service: Object.prototype.hasOwnProperty.call(ANALYTICS_AREAS, service) ? service : 'other',
    ...(referrer ? { referrerRoute: referrer } : {}),
  };
}

/** JSON.parse без прототипных ключей (тело уже разобрано Express — это для stream/outbox). */
export function safeJsonParse<T>(text: string): T {
  return JSON.parse(text, (key, value: unknown) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value)) as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const uuidOrNull = (v: unknown): string | null => (isUuid(v) ? v.toLowerCase() : null);

/** Календарный день момента в поясе платформы (`YYYY-MM-DD`). */
export function dayInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Сдвиг дня `YYYY-MM-DD` на n дней. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
