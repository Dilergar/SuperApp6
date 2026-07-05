// Сервер-layout Финансов: читает cookie состояния сайдбара, чтобы первый
// рендер сразу был в правильном виде (развёрнут/рейл) — без «прыжка»
// (модель shadcn/ui Sidebar). Suspense обязателен: FinanceShell использует
// useSearchParams (?book=).

import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { SIDEBAR_COOKIE } from '@/lib/service-nav';
import { FinanceShell } from './finance-shell';

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
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
      <FinanceShell defaultCollapsed={collapsed}>{children}</FinanceShell>
    </Suspense>
  );
}
