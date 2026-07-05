'use client';

import { SectionTitle } from '../tasks-ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksReviewPage() {
  return (
    <div style={{ maxWidth: 920 }}>
      <SectionTitle title="На проверке" subtitle="Исполнители сдали работу и ждут вашей приёмки. Откройте задачу — «Принять» или «Вернуть»." />
      <TaskListSection
        filter={{ smartList: 'on_review' }}
        emptyText="Никто не ждёт вашей приёмки"
        emptyHint="Когда по вашей задаче сдадут работу — она появится здесь"
      />
    </div>
  );
}
