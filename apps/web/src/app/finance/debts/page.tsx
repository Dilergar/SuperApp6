'use client';

// «Долги» — рассрочки и кредиты: прогресс, «Оплатить» в один тап.

import { PageHeader } from '@/components/ui';
import { DebtsPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceDebtsPage() {
  const { accounts, categories, people, bookId, canEdit, meId, meName, invalidate } = useFinanceBook();

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Долги"
        description="Сколько осталось выплатить и когда ближайший платёж"
      />
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
    </>
  );
}
