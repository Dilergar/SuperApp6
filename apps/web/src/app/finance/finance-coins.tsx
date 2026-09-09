'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CursorPage, FinCoinFeedItemDto, WalletEntry } from '@superapp/shared';
import { apiGet } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { formatWalletAmount } from '@/lib/wallet-format';
import {
  BentoGrid, Button, Card, CardHeader, EmptyState, Glyph, StatTile, type IconName, type Tone,
} from '@/components/ui';
import { PersonChip } from '../circles/PersonCard';
import { FinList, FinRow } from './finance-ui';

const coinFeedKey = ['finance', 'coins'] as const;
const walletSummaryKey = ['finance', 'coins', 'wallet'] as const;

async function fetchCoinFeed(cursor?: string): Promise<CursorPage<FinCoinFeedItemDto>> {
  return apiGet<CursorPage<FinCoinFeedItemDto>>('/finance/coins', {
    params: cursor ? { cursor } : undefined,
  });
}

// Локального `WalletRow` здесь БОЛЬШЕ НЕТ: он терял `scale` (по которому соседняя
// страница форматирует суммы) и объявлял `available/held/isOwn` необязательными,
// хотя на проводе они обязательны.
async function fetchWalletSummary(): Promise<WalletEntry[]> {
  return apiGet<WalletEntry[]>('/wallet');
}

/** Интерфейсный значок события ленты по его виду (валюта — эмодзи эмитента, это данные). */
const KIND_GLYPH: Record<string, { icon: IconName; tone: Tone }> = {
  task: { icon: 'checkCircle', tone: 'success' },
  order: { icon: 'shop', tone: 'accent' },
  mint: { icon: 'spark', tone: 'warning' },
  burn: { icon: 'bolt', tone: 'danger' },
};

/**
 * Вкладка «Коины» — внутренняя экономика экосистемы, ВИЗУАЛЬНО ОТДЕЛЬНО от фиата (PRD):
 * балансы кошелька + авто-лента (награды задач, покупки, казна) из леджера. Read-only.
 */
export function CoinsView() {
  const t = useTranslations('finance');
  const f = useFormatters();
  const { data: wallet = [] } = useQuery({ queryKey: walletSummaryKey, queryFn: fetchWalletSummary });
  const feed = useInfiniteQuery({
    queryKey: coinFeedKey,
    queryFn: ({ pageParam }) => fetchCoinFeed(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.items), [feed.data]);

  // До 4 валют — плитками показателей; остальные уходят в карточку кошелька
  const tiles = wallet.slice(0, 4);
  const rest = wallet.slice(4);

  return (
    <BentoGrid>
      {tiles.map((w) => (
        <StatTile
          key={w.currencyId}
          span={3}
          label={w.name}
          value={formatWalletAmount(w.balance, w.scale)}
          emoji={w.icon}
          tone={w.isOwn ? 'accent' : 'neutral'}
        />
      ))}
      {tiles.length === 0 && (
        <Card span={12}>
          <EmptyState
            icon="coins"
            title={t('coins.walletEmptyTitle')}
            description={t('coins.walletEmptyDescription')}
            action={<Button variant="matte" icon="tasks" href="/tasks">{t('coins.toTasks')}</Button>}
          />
        </Card>
      )}

      {rest.length > 0 && (
        <Card span={12} small>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <span className="label-caps">{t('coins.moreCurrencies')}</span>
            {rest.map((w) => (
              <span key={w.currencyId} className="title-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                <Glyph value={w.icon} size={15} />
                {formatWalletAmount(w.balance, w.scale)}
                <span className="label-sm">{w.name}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card span={12}>
        <CardHeader
          title={t('coins.feedTitle')}
          subtitle={t('coins.feedSubtitle')}
          actions={
            <Button variant="ghost" size="sm" href="/profile/wallet" iconRight="caretRight">
              {t('coins.wallet')}
            </Button>
          }
        />

        {items.length > 0 ? (
          <div className="density-compact">
            <FinList>
              {items.map((it) => {
                const g = KIND_GLYPH[it.kind];
                return (
                  <FinRow
                    key={it.id}
                    glyph={g ? g.icon : it.currencyIcon}
                    glyphTone={g ? g.tone : 'neutral'}
                    glyphFallback="coins"
                    title={
                      <>
                        {it.href ? (
                          <Link href={it.href} style={{ textDecoration: 'none', color: 'inherit' }}>{it.title}</Link>
                        ) : (
                          <span>{it.title}</span>
                        )}
                        {it.counterpartyUserId && it.counterpartyName && (
                          <PersonChip size="S" userId={it.counterpartyUserId} firstName={it.counterpartyName} />
                        )}
                        {!it.counterpartyUserId && it.counterpartyName && (
                          <span className="label-sm">{it.counterpartyName}</span>
                        )}
                      </>
                    }
                    subtitle={f.date(it.createdAt, 'dayMonthLong')}
                    right={
                      <span
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                          color: it.direction === 'in' ? 'var(--success)' : 'var(--danger)',
                        }}
                      >
                        {it.direction === 'in' ? '+' : '−'}{formatWalletAmount(it.amount, it.scale)} <Glyph value={it.currencyIcon} size={13} />
                      </span>
                    }
                  />
                );
              })}
            </FinList>
          </div>
        ) : (
          <EmptyState
            icon="coins"
            title={t('coins.feedEmptyTitle')}
            description={t('coins.feedEmptyDescription')}
          />
        )}

        {feed.hasNextPage && (
          <div style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
            <Button variant="matte" size="sm" onClick={() => feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
              {t('coins.loadMore')}
            </Button>
          </div>
        )}
      </Card>
    </BentoGrid>
  );
}
