import { DEFAULT_LOCALE, SOURCE_LOCALE, SUPPORTED_LOCALES, type Locale } from '@superapp/shared';

/**
 * Цепочка запасных языков. Сегодня она у всех одна и та же (`en` — язык
 * написания), потому что страж `check:i18n` требует 100 % паритета ключей
 * между en/kk/ru: фолбэк реально включится только для НОВОГО языка, который
 * ещё переводится (например, `kk-Latn` или `tr`).
 *
 * Порядок читается слева направо; сама локаль в цепочку не входит.
 */
export const FALLBACK_CHAIN: Record<Locale, readonly Locale[]> = {
  en: [],
  kk: [SOURCE_LOCALE],
  ru: [SOURCE_LOCALE],
};

/**
 * Региональный профиль форматов. НЕ язык: имена месяцев и дней приходят от
 * языка, а разделители, порядок частей даты и валюта — отсюда. Рынок один
 * (Казахстан), поэтому профиль сейчас один; когда регион станет настройкой
 * человека, здесь появится второй объект, а вызовы форматтеров не изменятся.
 *
 * Почему не берём готовый `ru-KZ`/`kk-KZ` от Intl: `ru-KZ` печатает
 * неразрывный пробел как разделитель групп и «₸» после суммы — это верно, но
 * ЗАВИСИТ от версии ICU в рантайме (Node, браузеры, мобильный движок расходятся).
 * Профиль фиксирует правила продукта, а Intl остаётся источником слов.
 */
export interface RegionProfile {
  /** Код страны ISO 3166-1 alpha-2 — им сверяется гео-сигнал запроса */
  readonly country: string;
  /**
   * Язык РЫНКА: на нём страна говорит, и его получает гость, чей браузер не
   * назвал ничего своего, кроме языка, распространённого в этой стране.
   * Не путать с `DEFAULT_LOCALE` (английский) — тот для чужаков.
   */
  readonly defaultLocale: Locale;
  /**
   * Язык браузера → язык продукта. Здесь живёт продуктовое решение, а не
   * лингвистика: русскоязычный посетитель в Казахстане получает КАЗАХСКИЙ,
   * потому что рынок один и государственный язык — казахский. Сменить язык
   * он может одним кликом переключателя, и выбор сохранится навсегда.
   */
  readonly languageRouting: Readonly<Record<string, Locale>>;
  /** Локаль-донор для Intl: даёт числовые/датовые правила региона */
  readonly numericLocale: string;
  readonly currency: string;
  /** Знак валюты для собственного рендера сумм */
  readonly currencySymbol: string;
  /** Разделитель дробной части */
  readonly decimalSeparator: string;
  /** Разделитель групп разрядов (узкий неразрывный пробел) */
  readonly groupSeparator: string;
  /** Порядок частей даты — читается форматтером dd.MM.yyyy */
  readonly dateSeparator: string;
  /** 24-часовые сутки (в РК 12-часовые не используются) */
  readonly hour12: false;
  /** Первый день недели: 1 = понедельник (ISO) */
  readonly firstDayOfWeek: 1;
  /** Пояс по умолчанию для СЕРВЕРНЫХ текстов (веб берёт пояс устройства) */
  readonly defaultTimeZone: string;
}

export const REGION_PROFILE_KZ: RegionProfile = {
  country: 'KZ',
  defaultLocale: 'kk',
  languageRouting: {
    kk: 'kk',
    // Русскоязычный браузер — это чаще всего человек В КАЗАХСТАНЕ (русская
    // Windows здесь массовая), а не в России: `ru-RU` — вариант ЯЗЫКА, а не
    // адрес. Поэтому по языку мы отправляем его на государственный, а «он
    // действительно в России» решает отдельный ГЕО-сигнал (см. resolve.ts).
    ru: 'kk',
    en: 'en',
  },
  numericLocale: 'ru-KZ',
  currency: 'KZT',
  currencySymbol: '₸',
  decimalSeparator: ',',
  groupSeparator: ' ', // NARROW NO-BREAK SPACE — не рвёт сумму переносом строки
  dateSeparator: '.',
  hour12: false,
  firstDayOfWeek: 1,
  defaultTimeZone: 'Asia/Almaty',
};

/**
 * Страны, чей житель по умолчанию остаётся на СВОЁМ языке, а не на языке рынка.
 * Сегодня одна: человек, который действительно находится в России и просит
 * русский, получает русский — казахский был бы для него ничем не лучше
 * английского. Определяется ГЕО-сигналом запроса, не заголовком языка.
 */
export const HOME_LANGUAGE_COUNTRIES: Readonly<Record<string, Locale>> = {
  RU: 'ru',
};

/** Пока регион один — функция существует ради будущей настройки, а не ради ветвления. */
export function regionProfileFor(_locale: Locale): RegionProfile {
  return REGION_PROFILE_KZ;
}

export { DEFAULT_LOCALE, SOURCE_LOCALE, SUPPORTED_LOCALES };
export type { Locale };
