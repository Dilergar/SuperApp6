// ============================================================
// User-Agent → грубые признаки устройства. ОДИН разбор на платформу: его зовут продуктовая
// аналитика (класс устройства в строке события) и журнал безопасности (подпись устройства
// «Chrome · Windows», ключ новизны клиента без X-Device-Id). Грубо и намеренно: версия,
// сборка и модель — это отпечаток устройства, а не признак.
// ============================================================

export type UaDeviceClass = 'desktop' | 'mobile' | 'tablet' | 'other';
export type UaOs = 'windows' | 'ios' | 'android' | 'macos' | 'linux' | 'other';
export type UaBrowser = 'edge' | 'opera' | 'yandex' | 'firefox' | 'chrome' | 'safari' | 'app' | 'other';

export interface ParsedUserAgent {
  deviceClass: UaDeviceClass | null;
  os: UaOs | null;
  browser: UaBrowser | null;
  /** «Chrome · Windows», «Safari · iPhone» — подпись устройства человеку (имена собственные, не переводятся) */
  label: string | null;
  /** Семейство «платформа·браузер·класс» — ключ новизны и колонка `ua_family` журнала */
  family: string | null;
}

const OS_LABEL: Record<UaOs, string> = { windows: 'Windows', ios: 'iOS', android: 'Android', macos: 'macOS', linux: 'Linux', other: '' };
const BROWSER_LABEL: Record<UaBrowser, string> = {
  edge: 'Edge',
  opera: 'Opera',
  yandex: 'Yandex Browser',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
  app: 'SuperApp6',
  other: '',
};

/**
 * Подпись и класс устройства из сохранённого семейства `os·browser·class` (журнал хранит
 * семейство, а не UA): «Chrome · Windows». Для iOS без UA не различить iPhone/iPad — «iOS».
 */
export function deviceFromFamily(family: string | null | undefined): { label: string | null; deviceClass: UaDeviceClass | null } {
  if (!family) return { label: null, deviceClass: null };
  const [os, browser, cls] = family.split('·') as [UaOs | undefined, UaBrowser | undefined, UaDeviceClass | undefined];
  const place = os === 'ios' ? (cls === 'tablet' ? 'iPad' : 'iPhone') : os ? OS_LABEL[os] ?? '' : '';
  const label = [browser ? BROWSER_LABEL[browser] ?? '' : '', place].filter(Boolean).join(' · ') || null;
  const deviceClass = cls && ['desktop', 'mobile', 'tablet', 'other'].includes(cls) ? cls : null;
  return { label, deviceClass };
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua) return { deviceClass: null, os: null, browser: null, label: null, family: null };
  const s = ua.slice(0, 512);
  const bot = /bot|crawl|spider|headless|lighthouse/i.test(s);
  const tablet = /ipad|tablet|(android(?!.*mobile))/i.test(s);
  const mobile = /mobi|iphone|ipod|android/i.test(s);
  const deviceClass: UaDeviceClass = bot ? 'other' : tablet ? 'tablet' : mobile ? 'mobile' : 'desktop';
  const os: UaOs = /windows/i.test(s)
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
  // Нативный клиент SuperApp6 (этап 2) шлёт `SuperApp6/<версия>` — это приложение, не браузер
  const browser: UaBrowser = /superapp6\//i.test(s)
    ? 'app'
    : /edg\//i.test(s)
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
  // Для iOS имя устройства человеку понятнее ОС: «Safari · iPhone», «Safari · iPad»
  const place = os === 'ios' ? (/ipad/i.test(s) ? 'iPad' : 'iPhone') : OS_LABEL[os];
  const label = [BROWSER_LABEL[browser], place].filter(Boolean).join(' · ') || null;
  return { deviceClass, os, browser, label, family: `${os}·${browser}·${deviceClass}` };
}
