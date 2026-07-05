'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksOverduePage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Просроченные" subtitle="Срок прошёл, а задача открыта. Передоговоритесь о сроке или закройте." />
      <TaskListSection
        filter={{ smartList: 'overdue' }}
        emptyText="Просроченных задач нет"
        emptyHint="Отличная дисциплина — так держать"
      />
    </div>
  );
}
