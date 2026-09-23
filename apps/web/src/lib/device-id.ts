import { newIdempotencyKey } from '@superapp/api-client';
import { AUDIT_HEADERS } from '@superapp/shared';

// ============================================================
// Устройство для журнала безопасности (core/audit): постоянный uuid браузера →
// заголовок `X-Device-Id` на каждом запросе (вход, refresh, гостевые и публичные ручки).
//
// Отдельно от устройства аналитики НАМЕРЕННО: аналитический id уважает отказ человека
// от аналитики и пропадает вместе с ним, а «вход с нового устройства», список устройств и
// cooling новой сессии — защита человека, от неё не отказываются. Выход из аккаунта id не
// стирает: иначе каждый следующий вход был бы «с нового устройства».
// ============================================================

const STORAGE_KEY = 'sa6.device';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id на время жизни вкладки, если localStorage недоступен (приватный режим, запрет сайта) */
let memory: string | null = null;

export function getDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && UUID_RE.test(stored)) return stored;
    const fresh = newIdempotencyKey();
    window.localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    memory ??= newIdempotencyKey();
    return memory;
  }
}

/** Заголовки безопасности для клиентов axios вне общего транспорта (гостевой, публичный вход Кабинета). */
export function securityHeaders(): Record<string, string> {
  const device = getDeviceId();
  return { [AUDIT_HEADERS.request]: newIdempotencyKey(), ...(device ? { [AUDIT_HEADERS.device]: device } : {}) };
}
