// Сервер-layout Финансов: читает cookie состояния сайдбара, чтобы первый
// рендер сразу был в правильном виде (развёрнут/рейл) — без «прыжка»
// (модель shadcn/ui Sidebar). Suspense обязателен: FinanceShell использует
// useSearchParams (?book=).

import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { SIDEBAR_COOKIE } from '@/lib/app-nav';
import { ServiceMessages } from '@/i18n/ServiceMessages';
import { FinanceShell } from './finance-shell';

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const collapsed = store.get(SIDEBAR_COOKIE)?.value === 'collapsed';
  const t = await getTranslations('common');

  return (
    <ServiceMessages ns={['finance', 'circles']}>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <p className="label-md" style={{ fontSize: '1rem' }}>{t('state.loading')}</p>
          </div>
        }
      >
        <FinanceShell defaultCollapsed={collapsed}>{children}</FinanceShell>
      </Suspense>
    </ServiceMessages>
  );
}
