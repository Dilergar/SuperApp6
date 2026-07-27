'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAllPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Все задачи" description="Полный список с поиском и фильтрами: статус, приоритет, моя роль." />
      <TaskListSection
        filter={{}}
        enableSearch
        enableFilters
        emptyText="Задач пока нет"
        emptyHint="Нажмите «+ Новая задача» или запишите быструю мысль во «Входящие»"
      />
    </>
  );
}
