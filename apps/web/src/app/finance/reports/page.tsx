'use client';

// «Отчёты» — план-факт месяца + лимиты + доходы + по людям + тренд.

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { ReportView } from '../finance-report';
import { useFinanceBook } from '../finance-shell';

export default function FinanceReportsPage() {
  const { bookId, categories, canEdit, overview } = useFinanceBook();
  const t = useTranslations('finance');
  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('reports.title')}
        description={t('reports.description')}
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
