'use client';

// «Близкие» — курируемый список людей для поля «на кого/от кого».

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui';
import { PeoplePanel } from '../finance-people';
import { useFinanceBook } from '../finance-shell';

export default function FinancePeoplePage() {
  const { people, bookId, canEdit, invalidate } = useFinanceBook();
  const t = useTranslations('finance');

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={t('people.title')}
        description={t('people.description')}
      />
      <PeoplePanel people={people} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
