'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDelegatedPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Я поставил" subtitle="Все задачи, где вы Постановщик, — себе и другим." />
      <TaskListSection
        filter={{ smartList: 'created_by_me' }}
        enableSearch
        emptyText="Вы пока не ставили задач"
        emptyHint="Нажмите «+ Новая задача» — себе, человеку или Группе"
      />
    </div>
  );
}
