'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { RichCardPayload } from '@superapp/shared';
import { LoadingBlock } from '@/components/ui/Feedback';
import { toastError } from '@/lib/toast';
import { apiErrorDetails } from '@/lib/api';
import { richCardKey } from '@/lib/queries';
import { fetchRichCard } from '@/lib/notifications-api';
import dynamic from 'next/dynamic';

// Виджет карточки — из графа мессенджера; грузится при первом раскрытии строки, а не
// с каркасом каждой страницы.
const RichCardWidget = dynamic(() => import('@/app/messenger/RichCardWidget').then((m) => m.RichCardWidget), { ssr: false });

// ============================================================
// Строка ленты раскрывается в ЖИВУЮ рич-карту core/rich-cards: тот же рендер и те
// же действия, что в чате (`GET /rich-cards/:refType/:refId`, `execute` с
// перепроверкой прав в момент нажатия). Объект удалён после фанаута (404) — тост
// «уже не существует» и строка помечается прочитанной, а не уход на 404-страницу.
// ============================================================

export function NotificationRichCard({ refType, refId, onGone }: { refType: string; refId: string; onGone?: () => void }) {
  const t = useTranslations('shell');
  const [card, setCard] = useState<RichCardPayload | null>(null);
  const q = useQuery({
    queryKey: richCardKey(refType, refId),
    queryFn: () => fetchRichCard(refType, refId),
    retry: false,
  });

  useEffect(() => {
    if (q.data) setCard(q.data);
  }, [q.data]);

  useEffect(() => {
    if (!q.error) return;
    const details = apiErrorDetails(q.error);
    const status = (q.error as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 403 || details?.code === 'db.notFound') {
      toastError(t('notifications.targetGone'));
      onGone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.error]);

  if (q.isLoading) return <LoadingBlock />;
  if (!card) return null;
  return <RichCardWidget payload={card} onActionDone={setCard} />;
}
