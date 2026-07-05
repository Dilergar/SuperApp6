'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksTodayPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="Сегодня" subtitle="Задачи со сроком на сегодня. Всё, что горит из прошлого, — в «Просроченных»." />
      <TaskListSection
        filter={{ smartList: 'today' }}
        emptyText="На сегодня задач нет"
        emptyHint="День свободен — или загляните в «Предстоящие»"
      />
    </div>
  );
}
