'use client';

// Редактор тяжёлый (BlockNote + Mantine) и живёт только в браузере —
// на страницу он попадает лениво, как канвас Процессов и комната звонка.
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { LoadingBlock } from '@/components/ui';

/** Своя подпись загрузки: `loading` у `dynamic` — отдельный компонент, а не строка */
function BuilderLoading() {
  const tr = useTranslations('documents');
  return <LoadingBlock text={tr('builder.opening')} />;
}

export const BuilderEditorLazy = dynamic(() => import('./BuilderEditor'), {
  ssr: false,
  loading: () => <BuilderLoading />,
});
