'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAllPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Все задачи" subtitle="Полный список с поиском и фильтрами: статус, приоритет, моя роль." />
      <TaskListSection
        filter={{}}
        enableSearch
        enableFilters
        emptyText="Задач пока нет"
        emptyHint="Нажмите «+ Новая задача» или запишите быструю мысль во «Входящие»"
      />
    </div>
  );
}
