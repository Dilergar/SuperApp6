'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDonePage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="Выполненные" description="Логбук: всё, что доведено до «Готово». Отменённые ищите в «Все задачи»." />
      <TaskListSection
        filter={{ status: ['done'] }}
        enableSearch
        emptyText="Пока ничего не выполнено"
        emptyHint="Закрытые задачи будут копиться здесь — приятно оглянуться"
      />
    </>
  );
}
