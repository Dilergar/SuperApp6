import { formatNumber } from '@superapp/i18n/format';
import { SOURCE_LOCALE } from '@superapp/shared';

// ============================================================
// Деньги сервиса «Объекты»: ставки, цены и стоимость ремонта приходят ЦЕЛЫМИ
// ТИЫНАМИ строкой (BigInt на проводе — только строкой).
//
// Разделители берутся из профиля РЕГИОНА, а не из языка: «250 000 ₸» в
// Казахстане пишется одинаково и для того, кто выбрал English. Поэтому функции
// чистые — хук и язык им не нужны, а `toLocaleString('ru-RU')` был бы сразу и
// языком, и регионом, зашитыми навсегда.
// ============================================================

/** Символ валюты: у тенге — знак, у прочих кодов сам код. */
function symbolOf(currency: string): string {
  return currency === 'KZT' ? '₸' : currency;
}

/** Целые единицы (уже поделённые) + валюта: «250 000 ₸». */
export function moneyMajor(value: number, currency = 'KZT'): string {
  if (!Number.isFinite(value)) return '';
  return `${formatNumber(value, { locale: SOURCE_LOCALE }, { maximumFractionDigits: 2 })} ${symbolOf(currency)}`;
}

/** Тиыны строкой → «250 000 ₸». */
export function moneyTiyn(tiyn: string | number | null | undefined, currency = 'KZT'): string {
  const n = Number(tiyn ?? 0) / 100;
  return moneyMajor(n, currency);
}
