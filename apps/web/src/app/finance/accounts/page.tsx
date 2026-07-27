'use client';

// «Счета» — управление счетами: создание, корректировка остатка.
// Кнопка-иконка «операции» открывает Ленту с фильтром по счёту.

import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { AccountsPanel } from '../finance-accounts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceAccountsPage() {
  const router = useRouter();
  const { accounts, bookId, canEdit, invalidate, withBook } = useFinanceBook();

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Счета"
        description="Где лежат деньги: наличные, карты, депозиты и долговые счета"
      />
      <AccountsPanel
        accounts={accounts}
        onChanged={invalidate}
        bookId={bookId}
        canEdit={canEdit}
        onOpenFeed={(accountId) => router.push(withBook('/finance/feed', { account: accountId }))}
      />
    </>
  );
}
