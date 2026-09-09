'use client';

// «Коины» — лента внутренней экономики (проекция кошелька-леджера).
// Только своя книга: экосистемные коины не шерятся (пункт скрыт в чужой
// книге, а прямой URL получает мягкую заглушку).

import { useTranslations } from 'next-intl';
import { BentoGrid, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { CoinsView } from '../finance-coins';
import { useFinanceBook } from '../finance-shell';

export default function FinanceCoinsPage() {
  const { isOwnBook, withBook } = useFinanceBook();
  const t = useTranslations('finance');

  if (!isOwnBook) {
    return (
      <>
        <PageHeader breadcrumb={t('breadcrumb')} title={t('coins.title')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="coins"
              title={t('coins.ownBookOnlyTitle')}
              description={t('coins.ownBookOnlyDescription')}
              action={
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Button variant="primary" href="/finance/coins">{t('coins.goToMyBook')}</Button>
                  <Button variant="ghost" icon="arrowLeft" href={withBook('/finance')}>{t('coins.backToOverview')}</Button>
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
        breadcrumb={t('breadcrumb')}
        title={t('coins.title')}
        description={t('coins.description')}
      />
      <CoinsView />
    </>
  );
}
