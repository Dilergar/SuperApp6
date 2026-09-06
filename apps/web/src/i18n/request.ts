import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { countryFromHeaders, loadAllMessages, negotiateLocale } from '@superapp/i18n';
import { LOCALE_COOKIE } from '@superapp/shared';

// ============================================================
// Конфигурация next-intl на СЕРВЕРЕ (RSC).
//
// Порядок выбора языка тот же, что у API: явный выбор человека (cookie
// `sa6_locale`, которую держит синхронной с `User.locale` хранилище сессии) →
// маршрут рынка по языку браузера (kk и ru → казахский, en → английский) →
// английский, если браузер не назвал ничего знакомого.
//
// `timeZone` НЕ задаём намеренно: время показывается в поясе УСТРОЙСТВА (модель
// Google Календаря). Серверный пояс нужен только текстам, которые уходят наружу
// (push/SMS) — их рисует API из `User.timezone`.
//
// Каталоги грузятся ЦЕЛИКОМ: это память сервера, а не байты клиента. На клиент
// уезжает только то, что положит в провайдер layout сервиса (см. ServiceMessages).
// ============================================================

export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  // Страна — из гео-заголовка CDN (в dev его нет, и это нормально): она нужна
  // ровно для случая «человек В РОССИИ просит русский». Региональный сабтег
  // `ru-RU` адресом НЕ считается — его шлёт русская Windows по всему миру.
  const locale = negotiateLocale(
    headerStore.get('accept-language'),
    cookieStore.get(LOCALE_COOKIE)?.value,
    { country: countryFromHeaders((name) => headerStore.get(name)) },
  );

  return {
    locale,
    messages: loadAllMessages(locale),
    // Пропущенный ключ в dev — громкая ошибка в консоли браузера: браузерная
    // проверка «0 ошибок консоли» ловит дыру в каталоге до того, как её увидит
    // человек. В проде — тихий фолбэк на сам ключ (текст не транзакция).
    onError(error) {
      if (process.env.NODE_ENV === 'development') console.error(`[i18n] ${error.message}`);
    },
    getMessageFallback: ({ key, namespace }) => (namespace ? `${namespace}.${key}` : key),
  };
});
