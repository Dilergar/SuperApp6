'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { NOTIFICATION_PERSONAL_CONTEXT, NOTIFICATION_SERVICE_KEYS, NOTIFICATION_STATES, notificationServicesForContext, type NotificationState } from '@superapp/shared';
import { Button, Card, Chip, PageHeader } from '@/components/ui';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { fetchWorkspaces, workspacesKey } from '@/lib/queries';
import type { NotificationFeedFilter } from '@/lib/notifications-api';
import { NotificationList } from '@/components/notifications/NotificationList';

// ============================================================
// Страница центра уведомлений (GitHub inbox): фильтры чипами — контекст (Везде /
// Личное / организации), сервис, состояние (Все / Непрочитанные / Упоминания /
// Сохранённые / Отложенные / Готово). Сквозная лента — контекст в адресе не нужен:
// это платформа, не сервис (в app-nav не добавляется, вход — колокольчик).
// ============================================================

type PageState = NotificationState | 'mentions';
const STATES: PageState[] = ['all', 'unread', 'mentions', 'saved', 'snoozed', 'archived'];

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const shell = useTranslations('shell');
  const { isReady } = useRequireAuth();
  const params = useSearchParams();
  const initial = params.get('filter');
  const [state, setState] = useState<PageState>(initial === 'mentions' ? 'mentions' : (NOTIFICATION_STATES as readonly string[]).includes(initial ?? '') ? (initial as NotificationState) : 'all');
  const [context, setContext] = useState<string | null>(params.get('context'));
  // `?service=security` — ссылка «Что мы вам присылали» раздела «Безопасность»: чужой ключ
  // сервиса (старая ссылка, опечатка) фильтром не становится
  const initialService = params.get('service');
  const [service, setService] = useState<string | null>(initialService && (NOTIFICATION_SERVICE_KEYS as readonly string[]).includes(initialService) ? initialService : null);

  const { data: workspaces = [] } = useQuery({ queryKey: workspacesKey, queryFn: fetchWorkspaces, staleTime: 60_000, enabled: isReady });

  // «Везде» = null: список сервисов сквозной, с личными (Финансы, Магазин, Кошелёк) —
  // иначе строку из личного сервиса в сквозной ленте нечем отфильтровать.
  const services = useMemo(() => notificationServicesForContext(context), [context]);
  const filter = useMemo<NotificationFeedFilter>(
    () => ({
      ...(context ? { context } : {}),
      ...(service ? { service } : {}),
      ...(state === 'mentions' ? { mentions: true } : state !== 'all' ? { state } : {}),
    }),
    [context, service, state],
  );

  if (!isReady) return null;

  return (
    <>
      <PageHeader
        breadcrumb={t('page.breadcrumb')}
        title={t('page.title')}
        description={t('page.description')}
        actions={<Button variant="outline" size="sm" icon="settings" href="/profile/notifications">{t('page.settingsLink')}</Button>}
      />

      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
          <FilterRow label={t('page.filters.state')}>
            {STATES.map((s) => (
              <Chip key={s} selected={state === s} onClick={() => setState(s)}>
                {t(`page.state.${s}`)}
              </Chip>
            ))}
          </FilterRow>
          {workspaces.length > 0 && (
            <FilterRow label={t('page.filters.context')}>
              <Chip selected={context === null} onClick={() => setContext(null)}>{t('page.allContexts')}</Chip>
              <Chip selected={context === NOTIFICATION_PERSONAL_CONTEXT} onClick={() => setContext(NOTIFICATION_PERSONAL_CONTEXT)}>{shell('context.personal')}</Chip>
              {workspaces.map((w) => (
                <Chip key={w.id} selected={context === w.id} onClick={() => setContext(w.id)}>{w.name}</Chip>
              ))}
            </FilterRow>
          )}
          <FilterRow label={t('page.filters.service')}>
            <Chip selected={service === null} onClick={() => setService(null)}>{t('page.allServices')}</Chip>
            {services.map((s) => (
              <Chip key={s} selected={service === s} onClick={() => setService(s)}>
                {t(`service.${s}`)}
              </Chip>
            ))}
          </FilterRow>
        </div>
        <NotificationList filter={filter} showContext={context === null} />
      </Card>
    </>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap' }}>
      <span className="label-caps" style={{ minWidth: '5.5rem' }}>{label}</span>
      {children}
    </div>
  );
}
