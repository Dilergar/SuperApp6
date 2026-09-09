'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksOverduePage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.overdue.title')} description={t('sections.overdue.description')} />
      <TaskListSection
        filter={{ smartList: 'overdue' }}
        emptyText={t('sections.overdue.empty')}
        emptyHint={t('sections.overdue.emptyHint')}
      />
    </>
  );
}
