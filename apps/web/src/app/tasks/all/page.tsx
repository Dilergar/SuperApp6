'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAllPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.all.title')} description={t('sections.all.description')} />
      <TaskListSection
        filter={{}}
        enableSearch
        enableFilters
        emptyText={t('sections.all.empty')}
        emptyHint={t('sections.all.emptyHint')}
      />
    </>
  );
}
