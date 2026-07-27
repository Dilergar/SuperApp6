'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDelegatedPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Я поставил" description="Все задачи, где вы Постановщик, — себе и другим." />
      <TaskListSection
        filter={{ smartList: 'created_by_me' }}
        enableSearch
        emptyText="Вы пока не ставили задач"
        emptyHint="Нажмите «+ Новая задача» — себе, человеку или Группе"
      />
    </>
  );
}
