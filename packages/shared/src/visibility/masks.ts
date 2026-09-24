import { normalizePhone } from '../utils/phone';
import type { Masked, VisibilityMaskKind, VisibilityRevealMode } from './types';

// ============================================================
// core/visibility — МАСКИ. Одна функция на вид данных, ЕДИНАЯ на всех поверхностях:
// карточка, ростер, Кабинет платформы, SMS-лог, страница проверки подписи. Две разные
// маски одного значения складываются в оригинал (Airbnb 2018: 40 % хозяев по сочетанию),
// поэтому дубли масковых функций вне этого файла запрещены линтером.
//
// Маска считается ТОЛЬКО на сервере: зритель получает `display` — символы маски, а не
// слова («скрыто» рисует зритель из каталога `common.guarded.*`).
// ============================================================

const DOT = '•';

/**
 * Телефон (решение грилла №5): `+77051234567` → `+7 70* *** *5 67` — видны код страны,
 * две цифры кода оператора, вторая цифра предпоследней пары и последняя пара. Этого
 * хватает, чтобы узнать «свой» номер, и мало, чтобы выгрузить базу поштучно.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Служебные заглушки (анонимизированный аккаунт, теневой бот) — не номер
  if (phone.startsWith('deleted:') || phone.startsWith('bot:')) return null;
  const digits = normalizePhone(phone).replace(/\D/g, '');
  if (digits.length === 11) {
    return `+${digits[0]} ${digits[1]}${digits[2]}* *** *${digits[8]} ${digits[9]}${digits[10]}`;
  }
  if (digits.length < 6) return '*'.repeat(digits.length);
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/** E-mail: `sanzhar@mail.kz` → `s•••@mail.kz` (домен виден — он редко идентифицирует). */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return `${DOT}${DOT}${DOT}`;
  return `${email[0]}${DOT}${DOT}${DOT}${email.slice(at)}`;
}

/**
 * ИИН / БИН / номер удостоверения / IBAN — ЕДИНСТВЕННАЯ маска: последние четыре. Первые
 * шесть цифр ИИН — дата рождения, седьмая — век и пол, поэтому «первые две + последние
 * четыре» выдавали бы год рождения рядом со скрытой датой.
 */
export function maskIdLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).replace(/\s+/g, '');
  if (s.length <= 4) return DOT.repeat(s.length);
  return `${DOT.repeat(s.length - 4)}${s.slice(-4)}`;
}

/** Фамилия до инициала: «Нурланов» → «Н.» (Kaspi-стиль). */
export function maskNameInitial(lastName: string | null | undefined): string | null {
  if (!lastName) return null;
  return `${lastName.charAt(0).toUpperCase()}.`;
}

/** Номер карты: всегда только последние четыре (PCI DSS 3.4.1). */
export function maskCardLast4(last4: string | null | undefined): string | null {
  if (!last4) return null;
  return `${DOT}${DOT}${DOT}${DOT} ${String(last4).slice(-4)}`;
}

/** Дата `YYYY-MM-DD` → только год. */
export function maskDateYear(isoDate: string | null | undefined): string | null {
  if (!isoDate || isoDate.length < 4) return null;
  return isoDate.slice(0, 4);
}

/** Дата `YYYY-MM-DD` → только день и месяц в форме ISO 8601 без года (`--MM-DD`, как у Graph API). */
export function maskDateMonthDay(isoDate: string | null | undefined): string | null {
  if (!isoDate || isoDate.length < 10) return null;
  return `--${isoDate.slice(5, 7)}-${isoDate.slice(8, 10)}`;
}

/** Корзины «был в сети» (Telegram): зритель видит код корзины, слово — из каталога. */
export const PRESENCE_BUCKETS = ['recently', 'week', 'month', 'long_ago'] as const;
export type PresenceBucket = (typeof PRESENCE_BUCKETS)[number];

/** Момент последней активности → корзина. `online` тоже попадает в `recently`. */
export function maskTimeBucket(lastSeen: Date | string | null | undefined, now: Date = new Date()): PresenceBucket | null {
  if (!lastSeen) return null;
  const t = typeof lastSeen === 'string' ? Date.parse(lastSeen) : lastSeen.getTime();
  if (!Number.isFinite(t)) return null;
  const days = (now.getTime() - t) / 86_400_000;
  if (days <= 3) return 'recently';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'long_ago';
}

/**
 * Деньги → диапазон корзины из реестра поля (`moneyBuckets`, минимальные единицы).
 * `display` — `"<от>..<до>"` либо `"<от>.."` у верхней корзины: число форматирует зритель.
 */
export function maskMoneyBucket(amount: string | number | bigint | null | undefined, buckets: readonly number[]): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  let v: number;
  try {
    v = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  } catch {
    return null;
  }
  if (!Number.isFinite(v) || !buckets.length) return null;
  let lo = 0;
  for (const b of buckets) {
    if (v < b) return `${lo}..${b}`;
    lo = b;
  }
  return `${lo}..`;
}

/**
 * Адрес → город. Надёжно выделить город из свободной строки нельзя, поэтому берём только
 * первый сегмент до запятой («г. Алматы, ул. …»); без запятой — маска без символов:
 * «улица целиком» не должна утечь под видом «города».
 */
export function maskAddressCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const comma = address.indexOf(',');
  if (comma <= 0) return null;
  const head = address.slice(0, comma).trim();
  return head && head.length <= 60 ? head : null;
}

/**
 * Гео: стабильное смещение на человека (Strava: круг вокруг точки вычисляется за 95 %,
 * значит шум обязан быть стабильным и не центрированным). `seed` — hex HMAC движка ключей
 * (соль на организацию/человека), радиус смещения ~300–700 м. Возвращает `"lat,lng"` с 3 знаками.
 */
export function maskGeoOffset(lat: number, lng: number, seedHex: string): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^[0-9a-f]{8,}$/i.test(seedHex)) return null;
  const a = parseInt(seedHex.slice(0, 4), 16) / 0xffff;
  const b = parseInt(seedHex.slice(4, 8), 16) / 0xffff;
  const angle = a * 2 * Math.PI;
  const meters = 300 + b * 400;
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return `${(lat + dLat).toFixed(3)},${(lng + dLng).toFixed(3)}`;
}

/** Контекст маски, которого нет в самом значении. */
export interface MaskContext {
  moneyBuckets?: readonly number[];
  now?: Date;
  geoSeed?: string;
}

/**
 * Единая точка: вид маски + значение → символы `display`. Неизвестный вид или значение
 * не той формы → `null` (маска без символов) — никогда не само значение.
 */
export function applyMask(mask: VisibilityMaskKind, value: unknown, ctx: MaskContext = {}): string | null {
  if (value === null || value === undefined) return null;
  switch (mask) {
    case 'phone_partial':
      return typeof value === 'string' ? maskPhone(value) : null;
    case 'email_partial':
      return typeof value === 'string' ? maskEmail(value) : null;
    case 'id_last4':
      return typeof value === 'string' ? maskIdLast4(value) : null;
    case 'name_initials':
      return typeof value === 'string' ? maskNameInitial(value) : null;
    case 'card_last4':
      return typeof value === 'string' ? maskCardLast4(value) : null;
    case 'date_year':
      return typeof value === 'string' ? maskDateYear(value) : value instanceof Date ? maskDateYear(value.toISOString()) : null;
    case 'date_month_day':
      return typeof value === 'string' ? maskDateMonthDay(value) : value instanceof Date ? maskDateMonthDay(value.toISOString()) : null;
    case 'time_bucket':
      return typeof value === 'string' || value instanceof Date ? maskTimeBucket(value, ctx.now) : null;
    case 'money_bucket':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? maskMoneyBucket(value, ctx.moneyBuckets ?? []) : null;
    case 'address_city':
      return typeof value === 'string' ? maskAddressCity(value) : null;
    case 'geo_offset': {
      if (!ctx.geoSeed || !value || typeof value !== 'object') return null;
      const g = value as { lat?: unknown; lng?: unknown };
      return typeof g.lat === 'number' && typeof g.lng === 'number' ? maskGeoOffset(g.lat, g.lng, ctx.geoSeed) : null;
    }
    case 'text_hidden':
    case 'hidden':
    default:
      return null;
  }
}

/**
 * Маркер маски `Guarded<T>` из сырого значения — ЕДИНСТВЕННЫЙ конструктор маркера вне
 * движка (витрина кита, тесты): литерал `{ $v: 'masked' }` вне `visibility/` запрещён линтером.
 */
export function maskedMarker(mask: VisibilityMaskKind, value: unknown, reveal: VisibilityRevealMode = 'none', ctx: MaskContext = {}): Masked {
  return { $v: 'masked', mask, display: applyMask(mask, value, ctx), reveal };
}

/**
 * Значение похоже на маску (`•`, `*` в шаблоне номера, `--MM-DD`)? Правка обязана
 * отвергать такое (`400 visibility.masked_value_rejected`): иначе форма, отрисованная
 * по маске, записала бы маску вместо данных.
 */
export function looksMasked(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.includes(DOT)) return true;
  if (/^\+\d[\d ]*\*[\d *]*$/.test(value)) return true;
  if (/^--\d{2}-\d{2}$/.test(value)) return true;
  return false;
}
