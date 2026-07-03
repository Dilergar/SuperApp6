'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { FinCoinFeedItemDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { PersonChip } from '../circles/PersonCard';

const coinFeedKey = ['finance', 'coins'] as const;
const walletSummaryKey = ['finance', 'coins', 'wallet'] as const;

async function fetchCoinFeed(cursor?: string): Promise<{ items: FinCoinFeedItemDto[]; nextCursor: string | null }> {
  const res = await api.get('/finance/coins', { params: cursor ? { cursor } : undefined });
  return { items: res.data.data, nextCursor: res.data.nextCursor ?? null };
}

interface WalletRow {
  currencyId: string;
  name: string;
  icon: string;
  balance: number;
  available?: number;
  held?: number;
  isOwn?: boolean;
}

async function fetchWalletSummary(): Promise<WalletRow[]> {
  const res = await api.get('/wallet');
  return res.data.data as WalletRow[];
}

/**
 * Вкладка «Коины» — внутренняя экономика экосистемы, ВИЗУАЛЬНО ОТДЕЛЬНО от фиата (PRD):
 * балансы кошелька + авто-лента (награды задач, покупки, казна) из леджера. Read-only.
 */
export function CoinsView() {
  const { data: wallet = [] } = useQuery({ queryKey: walletSummaryKey, queryFn: fetchWalletSummary });
  const feed = useInfiniteQuery({
    queryKey: coinFeedKey,
    queryFn: ({ pageParam }) => fetchCoinFeed(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.items), [feed.data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-6)' }}>
      <div className="card-elevated" style={{ transform: 'rotate(-0.2deg)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-3)' }}>
          <h2 className="title-md">Коины</h2>
          <Link href="/profile/wallet" className="label-sm" style={{ color: 'var(--secondary)' }}>Кошелёк →</Link>
        </div>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          Внутренняя экономика SuperApp6 — отдельно от реальных денег, чтобы не искажать вашу финансовую картину.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)' }}>
          {wallet.map((w) => (
            <span key={w.currencyId} className="ghost-border" style={{ padding: '0.35rem 0.9rem', background: 'var(--surface-container-lowest)', fontFamily: 'var(--font-display)', fontWeight: 700 }}>
              {w.icon} {w.balance.toLocaleString('ru-RU')} <span className="label-sm">{w.name}</span>
            </span>
          ))}
          {wallet.length === 0 && <p className="label-md">Кошелёк пока пуст.</p>}
        </div>
      </div>

      <div className="card" style={{ transform: 'rotate(0.2deg)' }}>
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-1)' }}>Лента экосистемы</h3>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          Награды за задачи, покупки в магазинах и выплаты казны попадают сюда сами — с комментарием и ссылкой.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-sketch)', padding: '0.5rem var(--spacing-4)' }}>
              <span style={{ fontSize: '1.1rem' }}>{it.kind === 'task' ? '✓' : it.kind === 'order' ? '🛍️' : it.kind === 'mint' ? '✨' : it.kind === 'burn' ? '🔥' : it.currencyIcon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.92rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {it.href ? <Link href={it.href} style={{ textDecoration: 'none', color: 'inherit' }}>{it.title}</Link> : <span>{it.title}</span>}
                  {it.counterpartyUserId && it.counterpartyName && (
                    <PersonChip size="S" userId={it.counterpartyUserId} firstName={it.counterpartyName} />
                  )}
                  {!it.counterpartyUserId && it.counterpartyName && (
                    <span className="label-sm">{it.counterpartyName}</span>
                  )}
                </div>
                <div className="label-sm">{new Date(it.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</div>
              </div>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: it.direction === 'in' ? 'var(--success)' : 'var(--danger)' }}>
                {it.direction === 'in' ? '+' : '−'}{it.amount.toLocaleString('ru-RU')} {it.currencyIcon}
              </span>
            </div>
          ))}
          {items.length === 0 && <p className="label-md">Пока пусто — получите первую награду за задачу!</p>}
        </div>
        {feed.hasNextPage && (
          <div style={{ textAlign: 'center', marginTop: 'var(--spacing-4)' }}>
            <button className="btn-secondary" style={{ padding: '0.4rem 1.4rem', fontSize: '0.85rem' }} onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
              {feed.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
