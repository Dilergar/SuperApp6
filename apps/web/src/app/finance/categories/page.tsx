'use client';

// «Категории» — дерево категорий расходов/доходов (до 2 уровней).

import { CategoriesPanel } from '../finance-categories';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCategoriesPage() {
  const { categories, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <div style={{ maxWidth: 680 }}>
      <CategoriesPanel categories={categories} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </div>
  );
}
