'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { TASK_LIMITS } from '@superapp/shared';
import { Alert, Card, PageHeader } from '@/components/ui';
import { TrashTable, type TrashRow } from '@/components/trash/TrashTable';
import { apiDelete, apiPost } from '@/lib/api';
import { fetchTasksTrash, tasksTrashKey } from '@/lib/queries';
import { useTasksService } from '../tasks-shell';

export default function TasksTrashPage() {
  const t = useTranslations('tasks');
  const { invalidate } = useTasksService();
  const { data, isPending } = useQuery({ queryKey: tasksTrashKey, queryFn: fetchTasksTrash });

  const rows: TrashRow[] | undefined = data?.map((item) => ({
    id: item.id,
    title: item.title,
    icon: 'tasks',
    meta: item.subtasksCount ? t('trash.subtasks', { count: item.subtasksCount }) : undefined,
    deletedAt: item.deletedAt,
    purgeAt: item.purgeAt,
  }));

  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.trash.title')} description={t('sections.trash.description')} />
      <div style={{ marginBottom: 16 }}>
        <Alert tone="neutral">{t('trash.hint', { days: TASK_LIMITS.trashRetentionDays })}</Alert>
      </div>
      <Card>
        <TrashTable
          rows={rows}
          loading={isPending}
          purgeConfirm={(row) => ({ title: t('trash.purgeConfirm.title', { name: row.title }), message: t('trash.purgeConfirm.message') })}
          onRestore={(row) => apiPost(`/tasks/${row.id}/restore`, {})}
          onPurge={(row) => apiDelete(`/tasks/${row.id}`)}
          // Корень ['tasks']: корзина, списки, счётчики и бейджи — одной инвалидацией
          onChanged={invalidate}
        />
      </Card>
    </>
  );
}
