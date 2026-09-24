'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CALENDAR_LIMITS } from '@superapp/shared';
import { Alert, Card, PageHeader } from '@/components/ui';
import { TrashTable, type TrashRow } from '@/components/trash/TrashTable';
import { apiDelete, apiPost } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { calendarTrashKey, fetchCalendarTrash } from '@/lib/queries';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';

export default function CalendarTrashPage() {
  const t = useTranslations('calendar');
  const { isReady } = useRequireAuth();
  const qc = useQueryClient();
  const fmt = useFormatters();
  const { data, isPending } = useQuery({ queryKey: calendarTrashKey, queryFn: fetchCalendarTrash, enabled: isReady });

  const rows: TrashRow[] | undefined = data?.map((item) => {
    const start = new Date(item.startTime);
    const when = item.allDay ? fmt.date(start) : `${fmt.date(start)} · ${fmt.timeRange(start, new Date(item.endTime))}`;
    return {
      id: item.id,
      title: item.title,
      icon: 'calendar',
      meta: item.recurring ? `${when} · ${t('trash.recurring')}` : when,
      deletedAt: item.deletedAt,
      purgeAt: item.purgeAt,
    };
  });

  return (
    <div style={{ padding: 'var(--spacing-6)', maxWidth: 1100 }}>
      <PageHeader breadcrumb={t('trash.breadcrumb')} title={t('trash.title')} description={t('trash.description')} />
      <div style={{ marginBottom: 16 }}>
        <Alert tone="neutral">{t('trash.hint', { days: CALENDAR_LIMITS.trashRetentionDays })}</Alert>
      </div>
      <Card>
        <TrashTable
          rows={rows}
          loading={isPending}
          purgeConfirm={(row) => ({ title: t('trash.purgeConfirm.title', { name: row.title }), message: t('trash.purgeConfirm.message') })}
          onRestore={(row) => apiPost(`/calendar/events/${row.id}/restore`, {})}
          onPurge={(row) => apiDelete(`/calendar/events/${row.id}`)}
          onChanged={() => void qc.invalidateQueries({ queryKey: calendarTrashKey })}
        />
      </Card>
    </div>
  );
}
