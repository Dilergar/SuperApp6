'use client';

// «Отчёты» — план-факт месяца + лимиты + доходы + по людям + тренд.

import { ReportView } from '../finance-report';
import { useFinanceBook } from '../finance-shell';

export default function FinanceReportsPage() {
  const { bookId, categories, canEdit, overview } = useFinanceBook();
  return (
    <div style={{ maxWidth: 920 }}>
      <ReportView
        categories={categories}
        bookId={overview?.book.id ?? null}
        queryBookId={bookId}
        canEdit={canEdit}
      />
    </div>
  );
}
