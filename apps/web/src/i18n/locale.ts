import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '@superapp/shared';
import { coerceLocale, isLocale, negotiateLocale } from '@superapp/i18n/locale';

// ============================================================
// Язык на вебе живёт в COOKIE, а не в адресе (модель Gmail/Salesforce).
//
// Почему не префикс `/kk/...`: адреса SuperApp6 — это deep-links, которые люди
// кидают друг другу в чат («вот задача», «вот документ»), и они уже несут
// контекст организации. Добавить туда язык значило бы переписать все хелперы
// адресов и получить N копий каждой ссылки в индексе и в переписках.
//
// Cookie читается СЕРВЕРОМ (первый кадр сразу правильный, без «моргания») и
// пишется КЛИЕНТОМ при смене языка; у авторизованного она синхронизируется с
// `User.locale`, чтобы язык переезжал между устройствами.
// ============================================================

export { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale, coerceLocale, negotiateLocale };
export type { Locale };

/** Строка cookie для `document.cookie` — путь корневой, срок год, SameSite=Lax. */
export function localeCookieValue(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Прочитать язык из `document.cookie` (клиент). Нет/мусор → null. */
export function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  const m = new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`).exec(document.cookie);
  const value: string | null = m ? decodeURIComponent(m[1]) : null;
  return isLocale(value) ? value : null;
}

/** Записать язык в cookie (клиент). */
export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.cookie = localeCookieValue(locale);
}
