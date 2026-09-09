'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAssignedPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.assigned.title')} description={t('sections.assigned.description')} />
      <TaskListSection
        filter={{ smartList: 'assigned_to_me' }}
        enableSearch
        emptyText={t('sections.assigned.empty')}
        emptyHint={t('sections.assigned.emptyHint')}
      />
    </>
  );
}
