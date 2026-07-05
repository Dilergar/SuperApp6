'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksUpcomingPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Предстоящие" subtitle="Всё со сроком после сегодняшнего дня — ближайшие сверху." />
      <TaskListSection
        filter={{ smartList: 'upcoming' }}
        emptyText="Запланированного пока нет"
        emptyHint="Задачи со сроком в будущем появятся здесь"
      />
    </div>
  );
}
