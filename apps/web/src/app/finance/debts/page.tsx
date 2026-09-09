'use client';

// «Долги» — рассрочки и кредиты: прогресс, «Оплатить» в один тап.

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { DebtsPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceDebtsPage() {
  const { accounts, categories, people, bookId, canEdit, meId, meName, invalidate } = useFinanceBook();
  const t = useTranslations('finance');

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('debts.title')}
        description={t('debts.description')}
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
