import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

// ============================================================
// Страница 404. До неё Next показывал СВОЮ стандартную — на английском
// («This page could not be found») посреди полностью русского продукта.
// Ловит и опечатки в адресе, и живые ссылки без страницы (например /workspaces
// без конкретной организации).
//
// Серверный компонент без состояния: лежит в корне app/, то есть отрисуется
// внутри каркаса (AppChrome) — сайдбар и топбар остаются на месте, и человек
// уходит дальше в один клик, а не «в никуда».
// ============================================================

export default async function NotFound() {
  const t = await getTranslations('shell');

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
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '3.5rem', fontWeight: 800, color: 'var(--primary)', lineHeight: 1 }}>
        404
      </div>
      <h1 className="title-lg" style={{ margin: 0 }}>{t('notFound.title')}</h1>
      <p className="body-sm" style={{ margin: 0, maxWidth: '30rem', color: 'var(--on-surface-variant)' }}>
        {t('notFound.text')}
      </p>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/dashboard" className="btn-primary">{t('error.goHome')}</Link>
        <Link href="/tasks" className="btn-ghost-inline">{t('error.goTasks')}</Link>
      </div>
    </div>
  );
}
