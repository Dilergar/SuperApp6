'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksReviewPage() {
  const t = useTranslations('tasks');
  return (
    <>
      <PageHeader breadcrumb={t('breadcrumb')} title={t('sections.review.title')} description={t('sections.review.description')} />
      <TaskListSection
        filter={{ smartList: 'on_review' }}
        emptyText={t('sections.review.empty')}
        emptyHint={t('sections.review.emptyHint')}
      />
    </>
  );
}
