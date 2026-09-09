'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

// Редактор — сторонний iframe, которому нужен живой DOM (form POST в фрейм и
// postMessage-мост): монтируем без SSR.
const DocumentEditor = dynamic(() => import('./DocumentEditor'), {
  ssr: false,
  loading: () => <EditorLoading />,
});

/** Заглушка загрузки — своя, потому что `loading` у `dynamic` хука каталога не имеет */
function EditorLoading() {
  const t = useTranslations('docs');
  return (
    <p className="label-md" style={{ padding: 'var(--spacing-4)' }}>
      {t('opening')}
    </p>
  );
}

export default function DocumentPage() {
  return <DocumentEditor />;
}
