'use client';

// ============================================================
// «Заказы»: входящие на мои витрины + мои покупки. Действия — эскроу
// (подтвердить/отклонить/вернуть/отозвать вклад), чат заказа рядом.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, apiErrorMessage } from '@/lib/api';
import { getOrderChat } from '@/lib/messenger-api';
import { PersonChip } from '../circles/PersonCard';
import {
  BentoGrid, Button, Card, CardHeader, Chip, EmptyState, Icon, LoadingBlock,
} from '@/components/ui';
import { glyphToText, type Order } from '@superapp/shared';
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONE, fmtAmount, fmtPrices, progressLines } from './shop-lib';

type OrderAction = 'confirm' | 'reject' | 'cancel' | 'refund' | 'withdraw';

export function OrdersView({ onError }: { onError: (m: string) => void }) {
  const router = useRouter();
  const [incoming, setIncoming] = useState<Order[]>([]);
  const [mine, setMine] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  // Открыть (или создать) контекстный чат заказа и перейти в мессенджер.
  const discuss = async (orderId: string) => {
    try {
      const chat = await getOrderChat(orderId);
      router.push(`/messenger?chat=${chat.id}`);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  const load = useCallback(async () => {
    try {
      const [inc, my] = await Promise.all([api.get('/shop/orders/incoming'), api.get('/shop/orders')]);
      setIncoming(inc.data.data);
      setMine(my.data.data);
    } catch (e) {
      onError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: OrderAction) => {
    try {
      await api.post(`/shop/orders/${id}/${action}`);
      await load();
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };

  const raisedText = (o: Order) =>
    progressLines(o.prices, o.raised)
      // Значок в строке: пометку набора печатать нельзя — glyphToText даёт символ
      .map((l) => `${fmtAmount(l.raised, l.scale)}/${fmtAmount(l.amount, l.scale)} ${glyphToText(l.currencyIcon)}`)
      .join(' · ');

  const row = (o: Order, kind: 'incoming' | 'mine') => (
    <div
      key={o.id}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
        padding: '0.625rem 0.75rem', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
      }}
    >
      {o.listingCoverUrl && (
        // Живая обложка лота (движок файлов, публичный класс)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={o.listingCoverUrl} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 'var(--radius-md)', flex: 'none' }} />
      )}
      {kind === 'incoming' && o.buyerName && <PersonChip size="S" userId={o.buyerId} firstName={o.buyerName} />}

      <div style={{ flex: '1 1 12rem', minWidth: 0 }}>
        <div className="title-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          {o.crowdfunding && <Icon name="target" size={15} style={{ color: 'var(--primary-dim)' }} />}
          {o.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
          <Chip size="sm" tone={ORDER_STATUS_TONE[o.status] ?? 'neutral'}>
            {ORDER_STATUS_LABELS[o.status] ?? o.status}
          </Chip>
          {kind === 'incoming' && o.crowdfunding && <Chip size="sm" tone="neutral">инициатор</Chip>}
        </div>
      </div>

      <span
        style={{
          fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--primary-dim)',
          fontSize: o.crowdfunding ? '0.75rem' : '0.9375rem', textAlign: 'right',
        }}
      >
        {o.crowdfunding ? raisedText(o) : fmtPrices(o.prices)}
      </span>

      <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {kind === 'incoming' && o.status === 'pending' && (
          <>
            <Button variant="primary" tone="success" size="sm" icon="check" onClick={() => act(o.id, 'confirm')}>Подтвердить</Button>
            <Button variant="matte" tone="danger" size="sm" icon="close" onClick={() => act(o.id, 'reject')}>Отклонить</Button>
          </>
        )}
        {kind === 'incoming' && o.crowdfunding && o.status === 'funding' && (
          <Button variant="ghost" size="sm" tone="danger" icon="close" onClick={() => act(o.id, 'reject')}>Отменить сбор</Button>
        )}
        {kind === 'incoming' && o.status === 'confirmed' && (
          <Button variant="ghost" size="sm" tone="danger" icon="undo" onClick={() => act(o.id, 'refund')}>Вернуть</Button>
        )}
        {kind === 'mine' && o.crowdfunding && o.status === 'funding' && (
          <Button variant="matte" tone="danger" size="sm" icon="undo" onClick={() => act(o.id, 'withdraw')}>Отозвать</Button>
        )}
        {kind === 'mine' && !o.crowdfunding && o.status === 'pending' && (
          <Button variant="ghost" size="sm" icon="close" onClick={() => act(o.id, 'cancel')}>Отменить</Button>
        )}
        {kind === 'mine' && o.status === 'confirmed' && o.withTask && (
          <Button variant="outline" size="sm" iconRight="caretRight" href="/tasks">Принять в Задачнике</Button>
        )}
        <Button variant="ghost" size="sm" icon="messenger" onClick={() => discuss(o.id)}>Обсудить</Button>
      </span>
    </div>
  );

  if (loading) return <LoadingBlock />;

  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader
          title="Заказы на мои витрины"
          subtitle="Подтверждение списывает коины из эскроу, отклонение — возвращает"
        />
        {incoming.length === 0 ? (
          <EmptyState icon="receipt" title="Пока нет заказов" description="Заказы на ваши товары появятся здесь." />
        ) : (
          <div className="density-compact ui-stack" style={{ gap: '0.375rem' }}>
            {incoming.map((o) => row(o, 'incoming'))}
          </div>
        )}
      </Card>

      <Card span={12}>
        <CardHeader title="Мои покупки" subtitle="Пока продавец не подтвердил — коины заморожены, а не списаны" />
        {mine.length === 0 ? (
          <EmptyState icon="shop" title="Вы ещё ничего не покупали" description="Витрины друзей — на вкладке «Магазины»." />
        ) : (
          <div className="density-compact ui-stack" style={{ gap: '0.375rem' }}>
            {mine.map((o) => row(o, 'mine'))}
          </div>
        )}
      </Card>
    </BentoGrid>
  );
}
