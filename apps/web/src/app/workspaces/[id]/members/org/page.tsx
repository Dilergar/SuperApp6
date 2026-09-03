'use client';

// ============================================================
// «Орг. структура» — витрина графа должностей и объектов. Канвас (React Flow) едет
// динамически без SSR (как Процессы); на ширине < 768 — дерево-список из тех же
// данных. Мастер «Соберём структуру» — на несобранной схеме.
// ============================================================

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { LoadingBlock } from '@/components/ui';
import { useMembersBase } from '../members-lib';

const OrgStructure = dynamic(() => import('./OrgStructure').then((m) => m.OrgStructure), {
  ssr: false,
  loading: () => <LoadingBlock />,
});

export default function MembersOrgPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  // Витрине схемы нужен только сам воркспейс: данные она берёт из ОДНОГО снимка
  // `GET /org/chart` (ростер и справочники здесь не рисуются).
  const { isReady, ws, wsQ } = useMembersBase(workspaceId, { members: false, staff: false });
  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;
  return <OrgStructure workspaceId={workspaceId} ws={ws} />;
}
