'use client';

// «Долги» — рассрочки и кредиты: прогресс, «Оплатить» в один тап.

import { DebtsPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceDebtsPage() {
  const { accounts, categories, people, bookId, canEdit, meId, meName, invalidate } = useFinanceBook();

  return (
    <div style={{ maxWidth: 680 }}>
      <DebtsPanel
        accounts={accounts}
        categories={categories}
        people={people}
        onChanged={invalidate}
        bookId={bookId}
        canEdit={canEdit}
        meId={meId}
        meName={meName}
      />
    </div>
  );
}
