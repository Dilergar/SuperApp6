import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AUDIT_HEADERS, type AuditClient } from '@superapp/shared';
import { parseUserAgent } from '../utils/user-agent';

/**
 * Контекст ЗАПРОСА для журнала безопасности и корреляции (core/audit): кто стучится —
 * откуда и чем. Строит `requestContextMiddleware` ДО гардов и кладёт в `req.ctx`;
 * интерцептор контекста переносит его в ALS (`WorkspaceContext.request`) — там его читает
 * `AuditService.record` без протаскивания через сервисы. Гарды (до интерцептора) берут
 * `req.ctx` из запроса сами.
 *
 * ALS прямо в Express-middleware НЕ ставится намеренно: колбэки body-parser исполняются в
 * асинхронном контексте сокета, а не того `run()`, и у запросов с телом контекст терялся бы.
 */
export interface RequestContext {
  /** uuid запроса: из `X-Request-Id` клиента (только uuid) либо новый; эхо в ответе */
  requestId: string;
  /** IP — только `req.ip` (TRUST_PROXY решает, сколько хопов XFF доверенные) */
  ip: string | null;
  /** User-Agent ≤ 512 */
  userAgent: string | null;
  /** «Chrome · Windows» */
  uaLabel: string | null;
  /** «windows·chrome·desktop» */
  uaFamily: string | null;
  deviceClass: 'desktop' | 'mobile' | 'tablet' | 'other' | null;
  /** Клиентский id устройства (`X-Device-Id`, только uuid) — не зависит от отказа от аналитики */
  deviceId: string | null;
  /** ISO-код страны из ДОВЕРЕННОГО гео-заголовка края сети (`GEO_COUNTRY_HEADER`; не задан — null) */
  country: string | null;
  /** Клиент — уточняет интерцептор (ключ API, Кабинет) */
  client: AuditClient;
  /** Шаблон маршрута (`/api/users/me/sessions/:id`) — ставит интерцептор, когда маршрут найден */
  route: string | null;
  startedAt: number;
  /**
   * Актор ИЗ АУТЕНТИФИКАЦИИ (а не из тела запроса): человек своей сессией или ключом, бот
   * ключом. Ставит интерцептор после гардов; до них (неудачный вход, заморозка без входа) — нет.
   */
  actor?: RequestActor;
}

export interface RequestActor {
  /** platform_staff — сотрудник Кабинета своей сессией Кабинета (`sessionId` = сессия Кабинета) */
  kind: 'user' | 'bot' | 'platform_staff';
  id: string;
  /** Строка сессии, выпустившая access-токен (`sid`) */
  sessionId: string | null;
  /** Семейство refresh-цепочки (`fam`) — «сессия» человека */
  familyId: string | null;
  keyId: string | null;
  /** R9: ключ/бот с доступом к контактным данным (класс `contact` движка видимости) */
  contactAccess?: boolean;
  /** Роли сотрудника платформы на момент запроса (только platform_staff) */
  roles?: readonly string[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/** Клиент по признакам запроса (без аутентификации): нативное приложение · мобильный веб · веб. */
export function clientOf(ua: ReturnType<typeof parseUserAgent>): AuditClient {
  if (ua.browser === 'app') return 'mobile';
  if (ua.deviceClass === 'mobile' || ua.deviceClass === 'tablet') return 'mobile_web';
  return 'web';
}

/**
 * Страна запроса ДЛЯ БЕЗОПАСНОСТИ (журнал, новизна страны входа, «откуда» ключа API) — только из
 * ОДНОГО заголовка, который ставит край сети и затирает у клиента (`GEO_COUNTRY_HEADER`, напр.
 * `cf-ipcountry` за Cloudflare). Список «любой из известных CDN» (`countryFromHeaders` — годится
 * лишь для догадки о языке) подделывается клиентом: `X-Country-Code: KZ` у угонщика из другой
 * страны гасил бы уведомление «вход из новой страны». Не задан — страны нет (честное «неизвестно»).
 */
export function trustedCountry(get: (name: string) => string | undefined): string | null {
  const name = process.env.GEO_COUNTRY_HEADER?.trim().toLowerCase();
  if (!name) return null;
  const v = get(name)?.trim();
  // Cloudflare отдаёт «XX» для запросов без страны (Tor), «T1» — для самого Tor
  return v && /^[A-Za-z]{2}$/.test(v) && !['XX', 'T1'].includes(v.toUpperCase()) ? v.toUpperCase() : null;
}

export function buildRequestContext(req: Request): RequestContext {
  const userAgent = header(req, 'user-agent')?.slice(0, 512) ?? null;
  const ua = parseUserAgent(userAgent);
  return {
    requestId: uuidOf(header(req, AUDIT_HEADERS.request)) ?? randomUUID(),
    ip: req.ip ?? null,
    userAgent,
    uaLabel: ua.label,
    uaFamily: ua.family,
    deviceClass: ua.deviceClass,
    deviceId: uuidOf(header(req, AUDIT_HEADERS.device)),
    country: trustedCountry((name) => header(req, name)),
    client: clientOf(ua),
    route: null,
    startedAt: Date.now(),
  };
}

export type RequestWithContext = Request & { ctx?: RequestContext };

/**
 * Express-middleware (main.ts, ДО гардов и body-parser): контекст запроса в `req.ctx` и эхо
 * `X-Request-Id` в ответе — клиент и поддержка сшивают жалобу с событиями журнала по нему.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx = buildRequestContext(req);
  (req as RequestWithContext).ctx = ctx;
  res.setHeader(AUDIT_HEADERS.request, ctx.requestId);
  next();
}
