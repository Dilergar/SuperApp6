'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Workspace } from '@superapp/shared';
import { IconButton } from '@/components/ui/Button';
import { usePopover } from '@/components/ui/usePopover';
import { useNotificationCounts } from '@/lib/hooks/useNotificationCounts';
import { notificationAction } from '@/lib/notifications-api';
import { NotificationPanel } from './NotificationPanel';

// ============================================================
// Колокольчик топбара — СКВОЗНОЙ (правило витрин): бейдж = unseen по всем контекстам,
// cap 99+, синий (красный в системе — только опасность). На узком экране поповер не
// открывается — колокольчик ведёт на страницу /notifications (телефону панель в 420px
// не по размеру). Realtime гасит бейдж во всех вкладках сразу.
// ============================================================

export function NotificationBell({ enabled, isMobile, workspaces }: { enabled: boolean; isMobile: boolean; workspaces: Workspace[] }) {
  const t = useTranslations('shell');
  const counts = useNotificationCounts(enabled);
  const pathname = usePathname();
  const { anchorRef, layerRef, open, setOpen, layerStyle } = usePopover<HTMLButtonElement>({ align: 'end', gap: 8, maxHeight: 640 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Переход по строке закрывает панель (каркас при клиентской навигации не размонтируется)
  useEffect(() => setOpen(false), [pathname, setOpen]);
  // Клик по push открыл `href?n=<id>` — строка помечается прочитанной (bell знает id из адреса)
  const params = useSearchParams();
  const fromPush = params.get('n');
  useEffect(() => {
    if (!fromPush || !enabled) return;
    void notificationAction(fromPush, 'read').catch(() => undefined);
  }, [fromPush, enabled]);

  const unseen = counts.unseen;
  const label = unseen > 0 ? t('topbar.notificationsUnread', { n: unseen }) : t('topbar.notifications');
  const badge = unseen > 0 && (
    <span className="ntf-bell-badge" aria-hidden>
      {unseen > 99 ? '99+' : unseen}
    </span>
  );

  if (isMobile) {
    return (
      <span className="ntf-bell">
        <IconButton href="/notifications" icon="bell" label={label} />
        {badge}
      </span>
    );
  }

  return (
    <span className="ntf-bell">
      <IconButton ref={anchorRef} icon={open ? 'bellRinging' : 'bell'} label={label} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" />
      {badge}
      {open &&
        mounted &&
        createPortal(
          <div ref={layerRef} className="ui-popover ntf-popover" style={panelStyle(layerStyle)}>
            <NotificationPanel workspaces={workspaces} counts={counts} onClose={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * usePopover считает left по ширине ЯКОРЯ (38px) — панель в 420px уехала бы за правый
 * край. Прижимаем к правой кромке окна с полем 8px и ужимаем на узком экране.
 */
function panelStyle(layerStyle: { left: number; [k: string]: unknown }): React.CSSProperties {
  const width = Math.min(420, window.innerWidth - 16);
  const left = Math.max(8, Math.min(layerStyle.left, window.innerWidth - width - 8));
  return { ...(layerStyle as React.CSSProperties), left, width, minWidth: undefined, padding: 0 };
}
