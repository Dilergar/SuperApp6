'use client';

// «Коины» — лента внутренней экономики (проекция кошелька-леджера).
// Только своя книга: экосистемные коины не шерятся (пункт скрыт в чужой
// книге, а прямой URL получает мягкую заглушку).

import Link from 'next/link';
import { CoinsView } from '../finance-coins';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCoinsPage() {
  const { isOwnBook, withBook } = useFinanceBook();

  if (!isOwnBook) {
    return (
      <div className="card" style={{ maxWidth: 560 }}>
        <h2 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Коины — только в своей книге</h2>
        <p className="label-md">
          Коин-лента показывает вашу личную экономику SuperApp6 и не входит в доступ к чужой книге.{' '}
          <Link href="/finance/coins" style={{ color: 'var(--secondary)' }}>Перейти в свою книгу →</Link>
        </p>
        <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>
          <Link href={withBook('/finance')} style={{ color: 'var(--secondary)' }}>← Назад к обзору книги</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 920 }}>
      <CoinsView />
    </div>
  );
}
