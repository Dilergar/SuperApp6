'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksOverduePage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Просроченные" description="Срок прошёл, а задача открыта. Передоговоритесь о сроке или закройте." />
      <TaskListSection
        filter={{ smartList: 'overdue' }}
        emptyText="Просроченных задач нет"
        emptyHint="Отличная дисциплина — так держать"
      />
    </>
  );
}
