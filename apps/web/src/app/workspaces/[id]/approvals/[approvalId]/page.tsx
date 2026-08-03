'use client';

// Карточка заявки ВНУТРИ организации: тот же компонент, но каркас остаётся
// рабочим — сверху активна организация, слева её сайдбар. Слаг называется
// `approvalId`, а не `id`: два одинаковых имени в одном пути Next не допускает
// (`[id]` уже занят организацией).

import { useParams } from 'next/navigation';
import { ApprovalCard } from '@/components/approvals/ApprovalCard';

export default function WorkspaceApprovalPage() {
  const { id, approvalId } = useParams<{ id: string; approvalId: string }>();
  return <ApprovalCard id={approvalId} contextWorkspaceId={id} />;
}
