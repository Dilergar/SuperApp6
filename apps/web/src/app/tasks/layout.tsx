// Сервер-layout Задач: читает cookie состояния сайдбара, чтобы первый рендер
// сразу был в правильном виде (развёрнут/рейл) — без «прыжка» (модель
// shadcn/ui Sidebar, образец — finance/layout.tsx). Suspense обязателен:
// ServiceShell внутри TasksShell использует useSearchParams.

import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { SIDEBAR_COOKIE } from '@/lib/service-nav';
import { TasksShell } from './tasks-shell';

export default async function TasksLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const collapsed = store.get(SIDEBAR_COOKIE)?.value === 'collapsed';

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
        </div>
      }
    >
      <TasksShell defaultCollapsed={collapsed}>{children}</TasksShell>
    </Suspense>
  );
}
