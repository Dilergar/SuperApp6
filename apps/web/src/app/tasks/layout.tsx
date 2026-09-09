// Сервер-layout Задач: читает cookie состояния сайдбара, чтобы первый рендер
// сразу был в правильном виде (развёрнут/рейл) — без «прыжка» (модель
// shadcn/ui Sidebar, образец — finance/layout.tsx). Он же кладёт в клиентский
// провайдер неймспейсы страницы (`common` и `shell` ServiceMessages добавит сам).
// `notes` — потому что карточка задачи рисует панель «Заметки».

import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { SIDEBAR_COOKIE } from '@/lib/app-nav';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { TasksShell } from './tasks-shell';

export default async function TasksLayout({ children }: { children: React.ReactNode }) {
  const [store, t] = await Promise.all([cookies(), getTranslations('common')]);
  const collapsed = store.get(SIDEBAR_COOKIE)?.value === 'collapsed';

  return (
    <ServiceMessages ns={['tasks', 'notes']}>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <p className="label-md" style={{ fontSize: '1rem' }}>{t('state.loading')}</p>
          </div>
        }
      >
        <TasksShell defaultCollapsed={collapsed}>{children}</TasksShell>
      </Suspense>
    </ServiceMessages>
  );
}
