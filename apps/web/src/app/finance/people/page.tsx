'use client';

// «Близкие» — курируемый список людей для поля «на кого/от кого».

import { PageHeader } from '@/components/ui';
import { PeoplePanel } from '../finance-people';
import { useFinanceBook } from '../finance-shell';

export default function FinancePeoplePage() {
  const { people, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Близкие"
        description="Кому и на кого чаще всего уходят деньги — для поля «на кого»"
      />
      <PeoplePanel people={people} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </>
  );
}
