'use client';

// «Счета» — управление счетами: создание, корректировка остатка.
// «операции →» открывает Ленту с фильтром по счёту.

import { useRouter } from 'next/navigation';
import { AccountsPanel } from '../finance-accounts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceAccountsPage() {
  const router = useRouter();
  const { accounts, bookId, canEdit, invalidate, withBook } = useFinanceBook();

  return (
    <div style={{ maxWidth: 680 }}>
      <AccountsPanel
        accounts={accounts}
        onChanged={invalidate}
        bookId={bookId}
        canEdit={canEdit}
        onOpenFeed={(accountId) => router.push(withBook('/finance/feed', { account: accountId }))}
      />
    </div>
  );
}
