'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAssignedPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Мне поставили" subtitle="Задачи, где вы Исполнитель или Соисполнитель — включая уже завершённые." />
      <TaskListSection
        filter={{ smartList: 'assigned_to_me' }}
        enableSearch
        emptyText="Вам пока ничего не поручали"
        emptyHint="Когда кто-то из окружения поставит вам задачу — она появится здесь"
      />
    </div>
  );
}
