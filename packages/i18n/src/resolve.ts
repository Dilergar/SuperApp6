import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
} from '@superapp/shared';
import { HOME_LANGUAGE_COUNTRIES, REGION_PROFILE_KZ } from './config';

/**
 * Разбор одного тега BCP-47 до языкового сабтега: `kk-Latn-KZ` → `kk`.
 * Регистр не значим (RFC 5646 §2.1.1).
 */
function languageSubtag(tag: string): string {
  return tag.trim().toLowerCase().split('-')[0] ?? '';
}

interface WeightedTag {
  tag: string;
  q: number;
}

/**
 * Разбор заголовка `Accept-Language` с q-весами.
 * `kk-KZ,kk;q=0.9,ru;q=0.8,en;q=0.7` → отсортированный по убыванию весов список.
 *
 * Своя реализация (а не `negotiator`) намеренно: пакет обязан работать и в
 * NestJS (CommonJS), и в Next, и в будущем React Native — лишняя зависимость
 * ради двадцати строк разбора здесь дороже, чем сами двадцать строк.
 */
function parseAcceptLanguage(header: string): WeightedTag[] {
  const out: WeightedTag[] = [];
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.split(';');
    const tag = rawTag?.trim();
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        // q вне [0,1] или мусор — тег считаем неназванным (RFC 9110 §12.4.2)
        q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    if (q > 0) out.push({ tag, q });
  }
  // Стабильная сортировка: при равных весах побеждает порядок из заголовка.
  return out
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map(({ tag, q }) => ({ tag, q }));
}

export interface NegotiateOptions {
  /**
   * Страна ЗАПРОСА (ISO 3166-1 alpha-2) из доверенного гео-заголовка CDN —
   * `CF-IPCountry` у Cloudflare, `X-Vercel-IP-Country` у Vercel.
   *
   * ВАЖНО: это единственный честный источник «где человек находится».
   * Региональный сабтег `Accept-Language` («RU» в `ru-RU`) им НЕ является:
   * `ru-RU` — вариант ЯЗЫКА, и его шлёт русская Windows по всему миру, включая
   * Казахстан. Приняв его за адрес, мы отправили бы половину своего рынка на
   * русский вместо государственного.
   */
  country?: string | null;
}

/**
 * Какой язык показать этому запросу.
 *
 * Порядок:
 *  1. явный выбор человека (`preferred`: cookie `sa6_locale` или `User.locale`) —
 *     он всегда сильнее любых догадок;
 *  2. человек НАХОДИТСЯ в стране, которая говорит на своём языке, и просит его
 *     (сегодня это Россия + русский) → отдаём его язык;
 *  3. язык браузера по убыванию q через маршрут региона: `kk`→kk, `ru`→**kk**
 *     (рынок — Казахстан, государственный язык казахский), `en`→en;
 *  4. ничего не совпало → `DEFAULT_LOCALE` (английский): человеку, чей язык мы
 *     не знаем, английский понятнее и казахского, и русского.
 *
 * `*` в заголовке НЕ считается совпадением: «любой язык» — это и есть случай,
 * для которого существует шаг 4.
 */
export function negotiateLocale(
  acceptLanguage?: string | null,
  preferred?: string | null,
  options: NegotiateOptions = {},
): Locale {
  if (isLocale(preferred)) return preferred;

  const region = REGION_PROFILE_KZ;
  const country = options.country?.trim().toUpperCase();
  const homeLocale = country && country !== region.country ? HOME_LANGUAGE_COUNTRIES[country] : undefined;

  if (!acceptLanguage) return DEFAULT_LOCALE;

  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    if (tag === '*') continue;
    const language = isLocale(tag) ? tag : languageSubtag(tag);
    // Человек В СВОЕЙ стране просит СВОЙ язык — маршрут рынка на него не действует.
    if (homeLocale && language === homeLocale) return homeLocale;
    const routed = region.languageRouting[language];
    if (routed) return routed;
  }
  return DEFAULT_LOCALE;
}

/** Нормализация значения из cookie / БД / query — всё, что не наше, отбрасываем. */
export function coerceLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  return isLocale(value) ? value : fallback;
}

/**
 * Имена гео-заголовков, которые ставят CDN. Порядок = приоритет; первый
 * найденный выигрывает. Их значение ДОВЕРЕННОЕ ровно потому, что до приложения
 * запрос доходит только через прокси — клиент подделать его не может.
 */
export const GEO_COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code'] as const;

/** Достать страну запроса из заголовков (регистр имени не важен). */
export function countryFromHeaders(
  get: (name: string) => string | null | undefined,
): string | undefined {
  for (const name of GEO_COUNTRY_HEADERS) {
    const value = get(name);
    // Cloudflare отдаёт «XX» для запросов без страны (Tor, приватные сети).
    if (value && value !== 'XX' && value.length === 2) return value.toUpperCase();
  }
  return undefined;
}

export { isLocale };
