import { ANALYTICS_LIMITS, type AnalyticsAreaKey } from './types';

// ============================================================
// Маршрут → шаблон и сервис (общая функция веба, mobile и сервера)
// ============================================================
// В событие уезжает ШАБЛОН (`/workspaces/:id/objects`), а не адрес: идентификаторы,
// токены ссылок и строка запроса — это личность и содержимое, им в аналитике не место.

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM_SEG = /^\d+$/;
/** Токен ссылки/кода: длинный сегмент с цифрой, заглавной или подчёркиванием (статические сегменты — слова через дефис). */
const TOKEN_SEG = /^[A-Za-z0-9_-]{16,}$/;
const TOKEN_MARK = /[0-9A-Z_]/;
const MAX_SEGMENTS = 8;

/** `/tasks/2f1c…/edit?x=1` → `/tasks/:id/edit`. */
export function routeTemplateOf(pathname: string): string {
  const path = String(pathname ?? '').split(/[?#]/)[0] ?? '';
  const segments = path
    .split('/')
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS)
    .map((seg) => {
      if (UUID_SEG.test(seg) || NUM_SEG.test(seg)) return ':id';
      if (TOKEN_SEG.test(seg) && TOKEN_MARK.test(seg)) return ':token';
      if (seg.length > 48 || !/^[A-Za-z0-9_.-]+$/.test(seg)) return ':seg';
      return seg.toLowerCase();
    });
  return `/${segments.join('/')}`.slice(0, ANALYTICS_LIMITS.maxRouteLength);
}

/**
 * Префиксы шаблонов → область. Порядок несущий: длинные префиксы организации идут
 * ДО общего `/workspaces`. Новый раздел веба = +1 строка (иначе он попадёт в `other`).
 */
const ROUTE_AREAS: ReadonlyArray<readonly [string, AnalyticsAreaKey]> = [
  ['/workspaces/:id/members', 'staff'],
  ['/workspaces/:id/objects', 'objects'],
  ['/workspaces/:id/notes', 'notes'],
  ['/workspaces/:id/processes', 'processes'],
  ['/workspaces/:id/office', 'office'],
  ['/workspaces/:id/drive', 'drive'],
  ['/workspaces/:id/documents', 'documents'],
  ['/workspaces/:id/counterparties', 'counterparties'],
  ['/workspaces/:id/approvals', 'approvals'],
  ['/workspaces/:id/sign', 'sign'],
  ['/workspaces/:id/links', 'share'],
  ['/workspaces/:id/wallet', 'wallet'],
  ['/workspaces', 'workspaces'],
  ['/dashboard', 'dashboard'],
  ['/tasks', 'tasks'],
  ['/calendar', 'calendar'],
  ['/messenger', 'messenger'],
  ['/mentions', 'messenger'],
  ['/circles', 'circles'],
  ['/notes', 'notes'],
  ['/drive', 'drive'],
  ['/docs', 'docs'],
  ['/finance', 'finance'],
  ['/shop', 'shop'],
  ['/recorder', 'recorder'],
  ['/my-documents', 'hr'],
  ['/approvals', 'approvals'],
  ['/sign', 'sign'],
  ['/check', 'sign'],
  ['/notifications', 'notifications'],
  ['/profile', 'profile'],
  ['/platform', 'platform'],
  ['/login', 'auth'],
  ['/register', 'auth'],
  ['/reset-password', 'auth'],
  ['/s', 'share'],
];

/** Область шаблона маршрута (`/` — витрина, неизвестное — `other`). */
export function serviceOfRoute(template: string): AnalyticsAreaKey {
  if (template === '/' || template === '') return 'landing';
  for (const [prefix, area] of ROUTE_AREAS) {
    if (template === prefix || template.startsWith(`${prefix}/`)) return area;
  }
  return 'other';
}
