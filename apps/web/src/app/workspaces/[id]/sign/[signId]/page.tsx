'use client';

import { use } from 'react';
import { SignRequestPage } from '@/components/sign/SignRequestPage';

/**
 * Карточка подписания ВНУТРИ организации. Слаг не `[id]` (он уже занят
 * организацией) — Next два одинаковых имени в одном пути не допускает; та же
 * причина, по которой у согласований `[approvalId]`.
 */
export default function WorkspaceSignPage({
  params,
}: {
  params: Promise<{ id: string; signId: string }>;
}) {
  const { id, signId } = use(params);
  return <SignRequestPage id={signId} contextWorkspaceId={id} />;
}
