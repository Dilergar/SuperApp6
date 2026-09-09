'use client';

// «Категории» — дерево категорий расходов/доходов (до 2 уровней).

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { CategoriesPanel } from '../finance-categories';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCategoriesPage() {
  const { categories, bookId, canEdit, invalidate } = useFinanceBook();
  const t = useTranslations('finance');

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('categories.title')}
        description={t('categories.description')}
      />
      <CategoriesPanel categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
