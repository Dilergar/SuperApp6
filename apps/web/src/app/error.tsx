'use client';

import { useEffect } from 'react';
import Link from 'next/link';

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
  useEffect(() => {
    // В консоль — чтобы ошибка не потерялась молча (в проде сюда встанет отправка
    // в трекер; digest — идентификатор серверной ошибки в логах Next).
    console.error('Ошибка страницы:', error);
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
      <h1 className="title-lg" style={{ margin: 0 }}>Страница не открылась</h1>
      <p className="body-sm" style={{ margin: 0, maxWidth: '32rem', color: 'var(--on-surface-variant)' }}>
        Что-то пошло не так при загрузке этого раздела. Остальное приложение работает — можно
        попробовать снова или перейти в другой раздел.
      </p>
      {error.digest && (
        <p className="label-sm" style={{ margin: 0, opacity: 0.6 }}>
          Код ошибки: {error.digest}
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button type="button" onClick={reset} className="btn-primary">Попробовать снова</button>
        <Link href="/dashboard" className="btn-ghost-inline">На главную</Link>
      </div>
    </div>
  );
}
