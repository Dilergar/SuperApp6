'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksTodayPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.today.title')} description={t('sections.today.description')} />
      <TaskListSection
        filter={{ smartList: 'today' }}
        emptyText={t('sections.today.empty')}
        emptyHint={t('sections.today.emptyHint')}
      />
    </>
  );
}
