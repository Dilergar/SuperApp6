'use client';

// «Категории» — дерево категорий расходов/доходов (до 2 уровней).

import { PageHeader } from '@/components/ui';
import { CategoriesPanel } from '../finance-categories';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCategoriesPage() {
  const { categories, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Категории"
        description="Дерево до двух уровней: лимит родителя считает и подкатегории"
      />
      <CategoriesPanel categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
