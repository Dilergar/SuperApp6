'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksUpcomingPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Предстоящие" description="Всё со сроком после сегодняшнего дня — ближайшие сверху." />
      <TaskListSection
        filter={{ smartList: 'upcoming' }}
        emptyText="Запланированного пока нет"
        emptyHint="Задачи со сроком в будущем появятся здесь"
      />
    </>
  );
}
