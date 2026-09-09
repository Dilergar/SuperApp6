import { useTranslations } from 'next-intl';

// Общий фолбэк ожидания для loading.tsx каждого сервиса.
//
// Почему НЕ один loading.tsx в корне app/: корневая граница оборачивает в Suspense
// и страницу 404 — и та навсегда застревает на спиннере (содержимое приходит от
// сервера, но фолбэк не снимается). Проверено: убираешь корневой loading.tsx —
// 404 рисуется, возвращаешь — снова вечный спиннер.
//
// Поэтому граница живёт в КАЖДОМ сервисе: переходы по-прежнему отвечают мгновенно
// (корневой layout динамический — читает cookie сайдбара, — и без границы клик
// молчит до полного ответа сервера), а 404 и ошибки маршрутов остаются снаружи.
//
// Серверный компонент, и `useTranslations` здесь СИНХРОННЫЙ (next-intl читает
// конфигурацию запроса): фолбэк Suspense обязан рисоваться мгновенно, поэтому
// `await getTranslations` тут запрещён — ждущий фолбэк бесполезен.
export default function RouteLoading() {
  const t = useTranslations('common');
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
      <span className="ui-spinner" style={{ width: 28, height: 28 }} aria-label={t('a11y.loading')} role="status" />
    </div>
  );
}
