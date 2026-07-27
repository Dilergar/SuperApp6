'use client';

import { PageHeader } from '@/components/ui';
import { TaskListSection } from '../TaskListSection';

export default function TasksReviewPage() {
  return (
    <>
      <PageHeader breadcrumb="Задачи" title="На проверке" description="Исполнители сдали работу и ждут вашей приёмки. Откройте задачу — «Принять» или «Вернуть»." />
      <TaskListSection
        filter={{ smartList: 'on_review' }}
        emptyText="Никто не ждёт вашей приёмки"
        emptyHint="Когда по вашей задаче сдадут работу — она появится здесь"
      />
    </>
  );
}
