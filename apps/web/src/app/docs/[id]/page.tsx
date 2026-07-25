'use client';

import dynamic from 'next/dynamic';

// Редактор — сторонний iframe, которому нужен живой DOM (form POST в фрейм и
// postMessage-мост): монтируем без SSR.
const DocumentEditor = dynamic(() => import('./DocumentEditor'), {
  ssr: false,
  loading: () => <p className="label-md" style={{ padding: 'var(--spacing-4)' }}>Открываем документ…</p>,
});

export default function DocumentPage() {
  return <DocumentEditor />;
}
