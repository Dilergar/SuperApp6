'use client';

// «Повторы» — повторяющиеся операции: авто-запись или напоминание.

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { RecurringPanel } from '../finance-debts';
import { useFinanceBook } from '../finance-shell';

export default function FinanceRecurringPage() {
  const { accounts, categories, bookId, canEdit, invalidate } = useFinanceBook();
  const t = useTranslations('finance');

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('recurring.title')}
        description={t('recurring.description')}
      />
      <RecurringPanel accounts={accounts} categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
