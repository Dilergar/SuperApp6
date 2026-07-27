'use client';

import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/stores/auth';
import { callsStatusKey } from '@/lib/queries';
import { getCallsStatus } from '@/lib/calls-api';

// Внутренность — лениво: она тянет socket.io-client, messenger-api и messenger-ui,
// а CallsWatcher смонтирован в Providers, то есть в корневом графе КАЖДОЙ страницы.
const IncomingCallWatcher = dynamic(
  () => import('./IncomingCallWatcher').then((m) => m.IncomingCallWatcher),
  { ssr: false },
);

/**
 * Глобальный слушатель входящих звонков (монтируется в Providers): дозвон ловится
 * на ЛЮБОЙ странице приложения, как в WhatsApp. Единственный источник модалки
 * входящего — страница мессенджера свою НЕ рендерит (двойного ринга нет).
 *
 * Побочный эффект (осознанный): сокет /messenger теперь живёт на всех страницах →
 * presence «онлайн» = «открыт SuperApp6», а не «открыт мессенджер».
 */
export function CallsWatcher() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const statusQ = useQuery({
    queryKey: callsStatusKey,
    queryFn: getCallsStatus,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
  if (!isAuthenticated || !meId || !statusQ.data?.enabled) return null;
  return <IncomingCallWatcher meId={meId} />;
}
