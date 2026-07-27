'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksAssignedPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Мне поставили" description="Задачи, где вы Исполнитель или Соисполнитель — включая уже завершённые." />
      <TaskListSection
        filter={{ smartList: 'assigned_to_me' }}
        enableSearch
        emptyText="Вам пока ничего не поручали"
        emptyHint="Когда кто-то из окружения поставит вам задачу — она появится здесь"
      />
    </>
  );
}
