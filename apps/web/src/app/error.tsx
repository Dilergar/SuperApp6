'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

// ============================================================
// Граница ошибок маршрута. Раньше её не было вовсе: любая ошибка отрисовки
// проваливалась в глобальный ErrorBoundary из providers.tsx игасила ВСЁ
// приложение целиком — вместе с сайдбаром и топбаром, то есть уйти со сломанной
// страницы можно было только перезагрузкой.
//
// Здесь ломается только содержимое маршрута: каркас остаётся, «Попробовать
// снова» перерисовывает страницу без перезагрузки (reset от Next), и рядом
// всегда есть выход на главную.
// ============================================================

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('shell');
  const common = useTranslations('common');

  useEffect(() => {
    // В консоль — чтобы ошибка не потерялась молча (в проде сюда встанет отправка
    // в трекер; digest — идентификатор серверной ошибки в логах Next).
    console.error('Route error:', error);
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--spacing-4)',
        minHeight: '60vh',
        textAlign: 'center',
        padding: 'var(--spacing-6)',
      }}
    >
      <h1 className="title-lg" style={{ margin: 0 }}>{t('error.routeTitle')}</h1>
      <p className="body-sm" style={{ margin: 0, maxWidth: '32rem', color: 'var(--on-surface-variant)' }}>
        {t('error.routeText')}
      </p>
      {error.digest && (
        <p className="label-sm" style={{ margin: 0, opacity: 0.6 }}>
          {t('error.digest', { digest: error.digest })}
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button type="button" onClick={reset} className="btn-primary">{common('actions.retry')}</button>
        <Link href="/dashboard" className="btn-ghost-inline">{t('error.goHome')}</Link>
      </div>
    </div>
  );
}
