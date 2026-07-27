'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksTodayPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Сегодня" description="Задачи со сроком на сегодня. Всё, что горит из прошлого, — в «Просроченных»." />
      <TaskListSection
        filter={{ smartList: 'today' }}
        emptyText="На сегодня задач нет"
        emptyHint="День свободен — или загляните в «Предстоящие»"
      />
    </>
  );
}
