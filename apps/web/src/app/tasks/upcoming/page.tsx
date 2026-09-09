'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksUpcomingPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.upcoming.title')} description={t('sections.upcoming.description')} />
      <TaskListSection
        filter={{ smartList: 'upcoming' }}
        emptyText={t('sections.upcoming.empty')}
        emptyHint={t('sections.upcoming.emptyHint')}
      />
    </>
  );
}
