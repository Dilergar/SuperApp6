'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDelegatedPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.delegated.title')} description={t('sections.delegated.description')} />
      <TaskListSection
        filter={{ smartList: 'created_by_me' }}
        enableSearch
        emptyText={t('sections.delegated.empty')}
        emptyHint={t('sections.delegated.emptyHint')}
      />
    </>
  );
}
