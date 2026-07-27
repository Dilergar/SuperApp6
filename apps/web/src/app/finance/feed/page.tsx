'use client';

// ============================================================
// «Лента» — быстрый ввод + операции по дням + фильтр по счёту (чипы).
// ============================================================

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { FinAccountDto, FinTransactionDto } from '@superapp/shared';
import { financeTransactionsKey, fetchFinanceTransactions } from '@/lib/queries';
import { BentoGrid, Chip, PageHeader } from '@/components/ui';
import { ShareCardModal } from '../../messenger/ShareCardModal';
import { QuickEntry, TransactionFeed } from '../finance-feed';
import { formatMoney } from '../finance-lib';
import { useFinanceBook } from '../finance-shell';

export default function FinanceFeedPage() {
  const { bookId, accounts, categories, people, canEdit, meId, meName, invalidate } = useFinanceBook();
  const search = useSearchParams();

  // ?account= — дип-линк «операции этого счёта» (со страницы «Счета»)
  const [accountFilter, setAccountFilter] = useState<string | null>(() => search.get('account'));
  const [editingTx, setEditingTx] = useState<FinTransactionDto | null>(null);
  const [shareTxId, setShareTxId] = useState<string | null>(null);

  const txFilter = useMemo(
    () => ({
      ...(accountFilter ? { accountId: accountFilter } : {}),
      ...(bookId ? { bookId } : {}),
    }),
    [accountFilter, bookId],
  );
  const txQuery = useInfiniteQuery({
    queryKey: financeTransactionsKey(txFilter),
    queryFn: ({ pageParam }) =>
      fetchFinanceTransactions({ ...txFilter, cursor: (pageParam as string | undefined) || undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const accountById = useMemo(() => {
    const map = new Map<string, FinAccountDto>();
    for (const a of accounts) map.set(a.id, a);
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [accounts, categories]);

  const transactions = useMemo(() => (txQuery.data?.pages ?? []).flatMap((p) => p.items), [txQuery.data]);

  return (
    <>
      <PageHeader
        breadcrumb="Финансы"
        title="Лента"
        description="Каждая запись — пара счетов: откуда ушло и куда пришло"
        chip={accountFilter ? <Chip tone="accent" icon="filter">{accountById.get(accountFilter)?.name ?? 'фильтр'}</Chip> : undefined}
      />

      {/* Фильтр по счёту — чипы с балансами (эмодзи счёта выбирает человек) */}
      {accounts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 'var(--gap-grid)' }}>
          {accounts.map((a) => {
            const active = accountFilter === a.id;
            return (
              <Chip
                key={a.id}
                tone="accent"
                selected={active}
                emoji={a.icon}
                icon={a.icon ? undefined : 'card'}
                onClick={() => setAccountFilter((cur) => (cur === a.id ? null : a.id))}
                title={active ? 'Убрать фильтр' : `Показать операции: ${a.name}`}
              >
                {a.name}
                <span className="label-sm" style={{ fontWeight: 500 }}>{formatMoney(a.balance, a.currencyCode)}</span>
              </Chip>
            );
          })}
        </div>
      )}

      <BentoGrid>
        {canEdit && (
          <QuickEntry
            span={12}
            accounts={accounts}
            categories={categories}
            people={people}
            editingTx={editingTx}
            onCancelEdit={() => setEditingTx(null)}
            onSaved={() => {
              setEditingTx(null);
              invalidate();
            }}
            bookId={bookId}
            meId={meId}
            meName={meName}
          />
        )}

        <TransactionFeed
          span={12}
          canEdit={canEdit}
          bookId={bookId}
          meId={meId}
          transactions={transactions}
          accountById={accountById}
          filterLabel={accountFilter ? accountById.get(accountFilter)?.name ?? null : null}
          onClearFilter={() => setAccountFilter(null)}
          onEdit={(tx) => {
            setEditingTx(tx);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onShare={(tx) => setShareTxId(tx.id)}
          onDeleted={invalidate}
          hasMore={!!txQuery.hasNextPage}
          loadingMore={txQuery.isFetchingNextPage}
          onLoadMore={() => txQuery.fetchNextPage()}
        />
      </BentoGrid>

      {shareTxId && (
        <ShareCardModal
          refType="fin_transaction"
          refId={shareTxId}
          title="Отправить операцию в чат"
          onClose={() => setShareTxId(null)}
        />
      )}
    </>
  );
}
