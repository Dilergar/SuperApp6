'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDonePage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.done.title')} description={t('sections.done.description')} />
      <TaskListSection
        filter={{ status: ['done'] }}
        enableSearch
        emptyText={t('sections.done.empty')}
        emptyHint={t('sections.done.emptyHint')}
      />
    </>
  );
}
