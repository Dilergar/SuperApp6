'use client';

// «Отчёты» — план-факт месяца + лимиты + доходы + по людям + тренд.

import { PageHeader } from '@/components/ui';
import { ReportView } from '../finance-report';
import { useFinanceBook } from '../finance-shell';

export default function FinanceReportsPage() {
  const { bookId, categories, canEdit, overview } = useFinanceBook();
  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Отчёты"
        description="План и факт по категориям, доходы, люди и динамика полугода"
      />
      <ReportView
        categories={categories}
        bookId={overview?.book.id ?? null}
        queryBookId={bookId}
        canEdit={canEdit}
      />
    </>
  );
}
