'use client';

// «Близкие» — курируемый список людей для поля «на кого/от кого».

import { PeoplePanel } from '../finance-people';
import { useFinanceBook } from '../finance-shell';

export default function FinancePeoplePage() {
  const { people, bookId, canEdit, invalidate } = useFinanceBook();

  return (
    <div style={{ maxWidth: 680 }}>
      <PeoplePanel people={people} onChanged={invalidate} bookId={bookId} canEdit={canEdit} />
    </div>
  );
}
