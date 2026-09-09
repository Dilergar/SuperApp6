'use client';

// Хроника объекта (core/chatter, refType='branch'): что менялось в объекте,
// штатке, графике и оборудовании — одной лентой.

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { ChatterPageDto } from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { Card, CardHeader, LoadingBlock } from '@/components/ui';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { apiGet } from '@/lib/api';
import { objectChatterKey } from '@/lib/queries';

export default function ObjectHistoryPage() {
  const t = useTranslations('objects');
  const { isReady } = useRequireAuth();
  const { id, objectId } = useParams<{ id: string; objectId: string }>();

  const { data, isPending } = useQuery({
    queryKey: objectChatterKey(id, objectId),
    queryFn: () => apiGet<ChatterPageDto>(`/chatter/branch/${objectId}`, { params: { limit: 50 } }),
    enabled: isReady && !!objectId,
  });

  if (!isReady) return null;

  return (
    <Card>
      <CardHeader title={t('tabs.history')} subtitle={t('history.subtitle')} />
      {isPending ? (
        <LoadingBlock />
      ) : (
        <ChronicleFeed
          entries={data?.items ?? []}
          actors={data?.actors ?? {}}
          emptyText={t('history.empty')}
        />
      )}
    </Card>
  );
}
