'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { NotificationCountsDto, Workspace } from '@superapp/shared';
import { NOTIFICATION_PERSONAL_CONTEXT } from '@superapp/shared';
import { Button, CloseChip } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuAction } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { useFormatters } from '@/lib/format';

import { notificationQuietKey, notificationsRootKey } from '@/lib/queries';
import {
  fetchNotificationQuiet,
  markNotificationsRead,
  markNotificationsSeen,
  pauseNotifications,
  type NotificationFeedFilter,
} from '@/lib/notifications-api';
import { NotificationList } from './NotificationList';
import { PushEnableCard } from './PushEnableCard';

import { toastApiError } from '@/lib/api-errors';
// ============================================================
// Панель у колокольчика (Salesforce tray + GitHub inbox): вкладки Все / Непрочитанные /
// @Упоминания, чипы контекста (только если у человека ≥1 организация), общий список,
// «Прочитать все», пауза тишины (луна: 30 мин / 1 ч / 2 ч / до утра), футер на страницу.
// Открытие панели помечает показанные строки просмотренными — бейдж гаснет.
// ============================================================

type Tab = 'all' | 'unread' | 'mentions';

export function NotificationPanel({
  workspaces,
  counts,
  onClose,
}: {
  workspaces: Workspace[];
  counts: NotificationCountsDto;
  onClose: () => void;
}) {
  const t = useTranslations('shell');
  const f = useFormatters();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('all');
  const [context, setContext] = useState<string | null>(null);

  const filter = useMemo<NotificationFeedFilter>(
    () => ({
      ...(context ? { context } : {}),
      ...(tab === 'unread' ? { state: 'unread' as const } : {}),
      ...(tab === 'mentions' ? { mentions: true } : {}),
    }),
    [tab, context],
  );

  const quietQ = useQuery({ queryKey: notificationQuietKey, queryFn: fetchNotificationQuiet, staleTime: 30_000 });
  const paused = quietQ.data?.pausedUntil ? new Date(quietQ.data.pausedUntil) : null;

  const invalidate = () => qc.invalidateQueries({ queryKey: notificationsRootKey });
  const seen = useMutation({ mutationFn: markNotificationsSeen, onSuccess: () => void invalidate() });
  const readAll = useMutation({
    mutationFn: () => markNotificationsRead({ all: true, ...(context ? { context } : {}) }),
    onSuccess: () => void invalidate(),
    onError: (e) => toastApiError(e),
  });
  const pause = useMutation({
    mutationFn: pauseNotifications,
    onSuccess: () => void qc.invalidateQueries({ queryKey: notificationQuietKey }),
    onError: (e) => toastApiError(e),
  });
  const onShown = useCallback((ids: string[]) => seen.mutate(ids), [seen]);

  const pauseItems: MenuAction[] = [
    { key: 'm30', label: t('notifications.pause.m30'), onClick: () => pause.mutate({ minutes: 30 }) },
    { key: 'h1', label: t('notifications.pause.h1'), onClick: () => pause.mutate({ minutes: 60 }) },
    { key: 'h2', label: t('notifications.pause.h2'), onClick: () => pause.mutate({ minutes: 120 }) },
    { key: 'morning', label: t('notifications.pause.morning'), onClick: () => pause.mutate({ untilMorning: true }) },
    ...(paused && paused > new Date()
      ? [{ key: 'clear', label: t('notifications.pause.clear'), icon: 'bell' as const, separatorBefore: true, onClick: () => pause.mutate({ clear: true }) }]
      : []),
  ];

  const tabs = [
    { key: 'all' as const, label: t('notifications.tabs.all') },
    { key: 'unread' as const, label: t('notifications.tabs.unread') },
    { key: 'mentions' as const, label: t('notifications.tabs.mentions') },
  ];

  return (
    <div className="ntf-panel" role="dialog" aria-label={t('notifications.title')}>
      <div className="ntf-panel-head">
        <span className="title-sm">{t('notifications.title')}</span>
        <span className="ntf-panel-head-actions">
          <Menu
            align="end"
            label={paused && paused > new Date() ? t('notifications.pause.active', { time: f.time(paused) }) : t('notifications.pause.label')}
            items={pauseItems}
            trigger={({ ref, onClick, ...aria }) => (
              <button
                ref={ref}
                onClick={onClick}
                {...aria}
                type="button"
                className={`ui-iconbtn ntf-panel-moon${paused && paused > new Date() ? ' is-on' : ''}`}
                aria-label={paused && paused > new Date() ? t('notifications.pause.active', { time: f.time(paused) }) : t('notifications.pause.label')}
              >
                <Icon name="moon" size={18} />
              </button>
            )}
          />
          <Button variant="ghost" size="sm" onClick={() => readAll.mutate()} loading={readAll.isPending}>
            {t('notifications.readAll')}
          </Button>
          <CloseChip onClick={onClose} />
        </span>
      </div>

      <div className="ntf-panel-tabs">
        <Tabs items={tabs} value={tab} onChange={setTab} aria-label={t('notifications.title')} />
      </div>

      {workspaces.length > 0 && (
        <div className="ntf-panel-contexts">
          <Chip selected={context === null} onClick={() => setContext(null)}>
            {t('notifications.contexts.all')}
          </Chip>
          <Chip selected={context === NOTIFICATION_PERSONAL_CONTEXT} onClick={() => setContext(NOTIFICATION_PERSONAL_CONTEXT)}>
            {t('context.personal')}
            {(counts.byContext[NOTIFICATION_PERSONAL_CONTEXT] ?? 0) > 0 && <span className="ntf-dot" aria-hidden />}
          </Chip>
          {workspaces.map((w) => (
            <Chip key={w.id} selected={context === w.id} onClick={() => setContext(w.id)}>
              {w.name}
              {(counts.byContext[w.id] ?? 0) > 0 && <span className="ntf-dot" aria-hidden />}
            </Chip>
          ))}
        </div>
      )}

      <div className="ntf-panel-body">
        <PushEnableCard />
        <NotificationList filter={filter} compact onShown={onShown} />
      </div>

      <div className="ntf-panel-foot">
        <Button variant="ghost" size="sm" href="/notifications" iconRight="arrowRight" onClick={onClose}>
          {t('notifications.allLink')}
        </Button>
      </div>
    </div>
  );
}
