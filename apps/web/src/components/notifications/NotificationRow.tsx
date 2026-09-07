'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { NotificationActorDto, NotificationDto, NotificationWorkspaceDto } from '@superapp/shared';
import { NOTIFICATION_PERSONAL_CONTEXT } from '@superapp/shared';
import { IconButton } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu, type MenuAction } from '@/components/ui/Menu';
import { Avatar, PersonAvatar } from '@/app/messenger/messenger-ui';
import { useFormatters } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { apiErrorMessage } from '@/lib/api';
import { notificationsRootKey } from '@/lib/queries';
import {
  muteNotificationRef,
  notificationAction,
  putNotificationPreferences,
  snoozeNotification,
} from '@/lib/notifications-api';
import { NotificationRichCard } from './NotificationRichCard';

// ============================================================
// Строка ленты (общая для панели колокольчика и страницы). Актор — карточка человека
// (PersonAvatar), без актора в контексте организации — её логотип, иначе — системный
// значок; поверх — значок типа из реестра (`icon` в DTO — ключ реестра Phosphor).
// Заголовок жирный, пока строка непрочитана; клик — прочитано + переход по deep link.
// Меню ⋯ — шесть пунктов: Прочитано · Готово · Сохранить · Отложить ·
// Не уведомлять об этом · Отключить такие. «Удалить» в UI НЕТ (только API).
// ============================================================

export interface NotificationRowProps {
  n: NotificationDto;
  actors: ReadonlyMap<string, NotificationActorDto>;
  workspaces: ReadonlyMap<string, NotificationWorkspaceDto>;
  /** Панель: теснее, без чипа контекста */
  compact?: boolean;
  /** Показывать чип организации (сквозная лента) */
  showContext?: boolean;
}

const SNOOZE_OPTIONS = ['h1', 'h3', 'morning', 'week'] as const;
type SnoozeOption = (typeof SNOOZE_OPTIONS)[number];

function snoozeUntil(option: SnoozeOption): Date {
  const now = new Date();
  switch (option) {
    case 'h1':
      return new Date(now.getTime() + 3600_000);
    case 'h3':
      return new Date(now.getTime() + 3 * 3600_000);
    case 'week':
      return new Date(now.getTime() + 7 * 86_400_000);
    case 'morning': {
      const d = new Date(now);
      d.setHours(8, 0, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
  }
}

export const NotificationRow = memo(function NotificationRow({ n, actors, workspaces, compact, showContext }: NotificationRowProps) {
  const t = useTranslations('shell');
  const router = useRouter();
  const qc = useQueryClient();
  const f = useFormatters();
  const [expanded, setExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const unread = n.readAt === null;
  const actor = n.actorId ? actors.get(n.actorId) : undefined;
  const ws = n.workspaceId ? workspaces.get(n.workspaceId) : undefined;
  const invalidate = () => qc.invalidateQueries({ queryKey: notificationsRootKey });

  const act = useMutation({
    mutationFn: async (action: 'read' | 'unread' | 'archive' | 'save' | 'unsave' | 'unsnooze') => notificationAction(n.id, action),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const snooze = useMutation({
    mutationFn: async (option: SnoozeOption) => snoozeNotification(n.id, snoozeUntil(option).toISOString()),
    onSuccess: () => {
      setSnoozeOpen(false);
      void invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const mute = useMutation({
    mutationFn: async () => {
      if (!n.ref) return;
      await muteNotificationRef(n.ref.type, n.ref.id);
    },
    onSuccess: () => toast(t('notifications.row.mutedToast'), 'success'),
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const disableType = useMutation({
    mutationFn: async () =>
      putNotificationPreferences({
        context: n.workspaceId ?? NOTIFICATION_PERSONAL_CONTEXT,
        overrides: [
          { subjectKind: 'type', subjectKey: n.type, channel: 'inapp', enabled: false },
          { subjectKind: 'type', subjectKey: n.type, channel: 'push', enabled: false },
        ],
      }),
    onSuccess: () => {
      toast(t('notifications.row.typeDisabledToast'), 'success');
      void qc.invalidateQueries({ queryKey: notificationsRootKey });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const open = () => {
    if (unread) act.mutate('read');
    if (n.href) {
      router.push(n.href);
      return;
    }
    if (n.richCardType) setExpanded((v) => !v);
  };

  const items: MenuAction[] = [
    { key: 'read', label: unread ? t('notifications.row.read') : t('notifications.row.unread'), icon: unread ? 'envelopeOpen' : 'mail', onClick: () => act.mutate(unread ? 'read' : 'unread') },
    { key: 'done', label: t('notifications.row.done'), icon: 'check', onClick: () => act.mutate('archive') },
    { key: 'save', label: n.savedAt ? t('notifications.row.unsave') : t('notifications.row.save'), icon: 'bookmark', onClick: () => act.mutate(n.savedAt ? 'unsave' : 'save') },
    { key: 'snooze', label: t('notifications.row.snooze'), icon: 'clock', onClick: () => setSnoozeOpen((v) => !v) },
    { key: 'mute', label: t('notifications.row.muteRef'), icon: 'bellSlash', disabled: !n.ref || n.priority === 'critical', onClick: () => mute.mutate() },
    { key: 'disable', label: t('notifications.row.disableType'), icon: 'bellSlash', disabled: n.priority === 'critical', separatorBefore: true, onClick: () => disableType.mutate() },
  ];

  const icon = (n.icon || 'bell') as IconName;

  return (
    <div className={`ntf-row${unread ? ' ntf-row--unread' : ''}${compact ? ' ntf-row--compact' : ''}`}>
      <div className="ntf-row-avatar" aria-hidden>
        {actor ? (
          <PersonAvatar userId={actor.id} name={`${actor.firstName} ${actor.lastName ?? ''}`.trim()} avatar={actor.avatar} size="sm" />
        ) : ws ? (
          <Avatar name={ws.name} avatar={ws.logo} size="sm" />
        ) : (
          <span className="ntf-row-sys">
            <Icon name={icon} size={16} />
          </span>
        )}
        {(actor || ws) && (
          <span className="ntf-row-typeicon">
            <Icon name={icon} size={11} />
          </span>
        )}
      </div>

      <button type="button" className="ntf-row-main" onClick={open} aria-label={n.title}>
        <span className="ntf-row-title">
          {n.title}
          {n.collapseCount > 1 && (
            <Chip size="sm" tone="accent" className="ntf-row-count">
              +{n.collapseCount - 1}
            </Chip>
          )}
        </span>
        {n.body && <span className="ntf-row-body">{n.body}</span>}
        <span className="ntf-row-meta meta">
          <span>{f.dateTime(n.sortAt)}</span>
          {showContext && ws && !compact && <Chip size="sm">{ws.name}</Chip>}
          {n.snoozedUntil && new Date(n.snoozedUntil) > new Date() && (
            <Chip size="sm" tone="waiting" icon="clock">
              {t('notifications.row.snoozedUntil', { time: f.dateTime(n.snoozedUntil) })}
            </Chip>
          )}
          {n.savedAt && <Icon name="bookmark" size={12} />}
        </span>
      </button>

      <div className="ntf-row-actions">
        {unread && <span className="ntf-row-dot" aria-hidden />}
        {n.richCardType && (
          <IconButton
            icon={expanded ? 'caretUp' : 'caretDown'}
            label={t('notifications.row.expand')}
            size={30}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          />
        )}
        <Menu items={items} label={t('notifications.row.menu')} align="end" />
      </div>

      {snoozeOpen && (
        <div className="ntf-row-snooze">
          {SNOOZE_OPTIONS.map((o) => (
            <Chip key={o} tone="accent" onClick={() => snooze.mutate(o)}>
              {t(`notifications.snooze.${o}`)}
            </Chip>
          ))}
        </div>
      )}

      {expanded && n.ref && n.richCardType && (
        <div className="ntf-row-card">
          <NotificationRichCard refType={n.ref.type} refId={n.ref.id} onGone={() => act.mutate('read')} />
        </div>
      )}
    </div>
  );
});
