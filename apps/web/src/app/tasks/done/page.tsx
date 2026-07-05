'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksDonePage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Выполненные" subtitle="Логбук: всё, что доведено до «Готово». Отменённые ищите в «Все задачи»." />
      <TaskListSection
        filter={{ status: ['done'] }}
        enableSearch
        emptyText="Пока ничего не выполнено"
        emptyHint="Закрытые задачи будут копиться здесь — приятно оглянуться"
      />
    </div>
  );
}
