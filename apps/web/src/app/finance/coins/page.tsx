'use client';

// «Коины» — лента внутренней экономики (проекция кошелька-леджера).
// Только своя книга: экосистемные коины не шерятся (пункт скрыт в чужой
// книге, а прямой URL получает мягкую заглушку).

import { BentoGrid, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { CoinsView } from '../finance-coins';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCoinsPage() {
  const { isOwnBook, withBook } = useFinanceBook();

  if (!isOwnBook) {
    return (
      <>
        <PageHeader breadcrumb="Финансы" title="Коины" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="coins"
              title="Коины — только в своей книге"
              description="Коин-лента показывает вашу личную экономику SuperApp6 и не входит в доступ к чужой книге."
              action={
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Button variant="primary" href="/finance/coins">Перейти в свою книгу</Button>
                  <Button variant="ghost" icon="arrowLeft" href={withBook('/finance')}>К обзору книги</Button>
                </div>
              }
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Коины"
        description="Внутренняя экономика SuperApp6 — отдельно от реальных денег, чтобы не искажать финансовую картину"
      />
      <CoinsView />
    </>
  );
}
