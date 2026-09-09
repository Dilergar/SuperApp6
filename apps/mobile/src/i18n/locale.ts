import { create } from 'zustand';
import { DEFAULT_LOCALE, type Locale } from '@superapp/shared';
import { negotiateLocale } from '@superapp/i18n/locale';

// ============================================================
// Язык мобильного клиента.
//
// Порядок тот же, что у веба и API: явный выбор человека (`User.locale`, он же
// приезжает с профилем) → язык УСТРОЙСТВА через маршрут рынка → английский.
// Отдельного хранилища выбора здесь нет намеренно: выбор живёт в аккаунте, а не
// в устройстве, — человек, сменивший язык в вебе, открывает телефон уже на нём.
// ============================================================

/**
 * Язык системы как тег BCP-47. `Intl` в Hermes есть (RN 0.73+), но обёртка нужна:
 * на урезанной сборке рантайма конструктор кидает, и приложение не должно падать
 * из-за подсказки о языке.
 */
function deviceTag(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

/** Язык устройства, пропущенный через маршрут рынка (`ru` → `kk` в Казахстане). */
export function deviceLocale(): Locale {
  return negotiateLocale(deviceTag()) ?? DEFAULT_LOCALE;
}

interface LocaleState {
  locale: Locale;
  /** Профиль приехал (или человек сменил язык) — язык аккаунта побеждает устройство. */
  setLocale: (locale: Locale | null | undefined) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: deviceLocale(),
  setLocale: (locale) => set({ locale: locale ?? deviceLocale() }),
}));

/**
 * Язык для заголовка `X-Locale` транспорта. Читается СИНХРОННО из стора, а не из
 * React: перехватчик axios живёт вне дерева компонентов.
 */
export function currentLocale(): Locale {
  return useLocaleStore.getState().locale;
}
