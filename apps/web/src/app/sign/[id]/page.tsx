'use client';

import { use } from 'react';
import { SignRequestPage } from '@/components/sign/SignRequestPage';

/**
 * Личный адрес карточки подписания. Рабочая заявка отсюда САМА переезжает в свою
 * организацию — так самолечатся уже разосланные уведомления, чей actionUrl
 * записан в БД и переписать его задним числом нельзя.
 */
export default function SignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SignRequestPage id={id} contextWorkspaceId={null} />;
}
