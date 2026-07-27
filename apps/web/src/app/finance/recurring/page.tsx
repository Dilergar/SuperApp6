'use client';

// «Повторы» — повторяющиеся операции: авто-запись или напоминание.

import { PageHeader } from '@/components/ui';
import { RecurringPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceRecurringPage() {
  const { accounts, categories, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Повторы"
        description="Аренда, подписки и зарплата — записываются сами или напоминают"
      />
      <RecurringPanel accounts={accounts} categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
