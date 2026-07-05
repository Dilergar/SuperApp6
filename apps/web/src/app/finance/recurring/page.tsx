'use client';

// «Повторы» — повторяющиеся операции: авто-запись или напоминание.

import { RecurringPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceRecurringPage() {
  const { accounts, categories, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <div style={{ maxWidth: 680 }}>
      <RecurringPanel accounts={accounts} categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </div>
  );
}
