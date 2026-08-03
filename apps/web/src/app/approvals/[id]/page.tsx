'use client';

// Личный адрес карточки заявки. Реализация одна на оба маршрута — см.
// components/approvals/ApprovalCard. Рабочую заявку карточка сама переадресует
// внутрь её организации: по этому пути приходят уже разосланные уведомления.

import { useParams } from 'next/navigation';
import { ApprovalCard } from '@/components/approvals/ApprovalCard';

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  return <ApprovalCard id={id} />;
}
