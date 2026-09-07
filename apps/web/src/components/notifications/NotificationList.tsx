'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { NotificationActorDto, NotificationWorkspaceDto } from '@superapp/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Card';
import { LoadingBlock } from '@/components/ui/Feedback';
import { notificationsFeedInfinite } from '@/lib/queries';
import type { NotificationFeedFilter } from '@/lib/notifications-api';
import { NotificationRow } from './NotificationRow';

// ============================================================
// Общий список — один и тот же для панели колокольчика и страницы: одна бесконечная
// форма кэша на ключ фильтра, «Показать ещё» по курсору. Панель сообщает наверх
// показанные id (→ POST /seen, бейдж гаснет; строки остаются жирными до клика).
// ============================================================

export function NotificationList({
  filter,
  compact,
  showContext,
  onShown,
}: {
  filter: NotificationFeedFilter;
  compact?: boolean;
  showContext?: boolean;
  onShown?: (ids: string[]) => void;
}) {
  const t = useTranslations('shell');
  const q = useInfiniteQuery(notificationsFeedInfinite(filter));
  const pages = q.data?.pages ?? [];

  const { items, actors, workspaces } = useMemo(() => {
    const actors = new Map<string, NotificationActorDto>();
    const workspaces = new Map<string, NotificationWorkspaceDto>();
    const seen = new Set<string>();
    const items = [];
    for (const p of pages) {
      for (const a of p.actors) actors.set(a.id, a);
      for (const w of p.workspaces) workspaces.set(w.id, w);
      for (const n of p.items) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        items.push(n);
      }
    }
    return { items, actors, workspaces };
  }, [pages]);

  // Показанные → просмотрены (один раз на id за жизнь списка)
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!onShown) return;
    const fresh = items.filter((n) => n.seenAt === null && !reported.current.has(n.id)).map((n) => n.id);
    if (!fresh.length) return;
    for (const id of fresh) reported.current.add(id);
    onShown(fresh);
  }, [items, onShown]);

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) {
    return <EmptyState icon="warning" title={t('notifications.loadError')} action={<Button variant="outline" size="sm" onClick={() => void q.refetch()}>{t('notifications.retry')}</Button>} />;
  }
  if (!items.length) {
    return <EmptyState icon="bell" title={t('notifications.empty.title')} description={compact ? undefined : t('notifications.empty.description')} />;
  }

  return (
    <div className="ntf-list">
      {items.map((n) => (
        <NotificationRow key={n.id} n={n} actors={actors} workspaces={workspaces} compact={compact} showContext={showContext} />
      ))}
      {q.hasNextPage && (
        <div className="ntf-list-more">
          <Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('notifications.showMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
