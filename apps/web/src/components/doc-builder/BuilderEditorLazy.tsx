'use client';

// Редактор тяжёлый (BlockNote + Mantine) и живёт только в браузере —
// на страницу он попадает лениво, как канвас Процессов и комната звонка.
import dynamic from 'next/dynamic';
import { LoadingBlock } from '@/components/ui';

export const BuilderEditorLazy = dynamic(() => import('./BuilderEditor'), {
  ssr: false,
  loading: () => <LoadingBlock text="Открываю конструктор…" />,
});
