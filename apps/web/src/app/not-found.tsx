import Link from 'next/link';

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

export default function NotFound() {
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
      <h1 className="title-lg" style={{ margin: 0 }}>Страница не найдена</h1>
      <p className="body-sm" style={{ margin: 0, maxWidth: '30rem', color: 'var(--on-surface-variant)' }}>
        Возможно, адрес набран с опечаткой, или эта страница больше не существует.
      </p>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/dashboard" className="btn-primary">На главную</Link>
        <Link href="/tasks" className="btn-ghost-inline">К задачам</Link>
      </div>
    </div>
  );
}
