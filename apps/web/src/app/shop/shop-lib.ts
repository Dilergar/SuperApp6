// ============================================================
// My Wish & Shop — общая обвязка: форматирование мультивалютной цены,
// прогресс краудфандинга, состояние доступности лота.
// ============================================================

import { glyphToText, type ContributionLine, type Contact, type Listing, type ListingPriceDto } from '@superapp/shared';
import type { Tone } from '@/components/ui';

/** Минимальные единицы → «12 500» по масштабу валюты. */
export const fmtAmount = (amount: number, scale: number) =>
  (scale > 0 ? amount / 10 ** scale : amount).toLocaleString('ru-RU');

/**
 * Кросс-валютная цена как «100 🍎 + 50 🪙» (значок валюты — данные эмитента).
 * Здесь получается СТРОКА, поэтому значок прогоняется через `glyphToText`:
 * печатать значение как есть нельзя — у него бывает пометка набора ('fl:1f34e').
 */
export const fmtPrices = (prices: Pick<ListingPriceDto, 'amount' | 'scale' | 'currencyIcon'>[]) =>
  prices.length ? prices.map((p) => `${fmtAmount(p.amount, p.scale)} ${glyphToText(p.currencyIcon)}`.trim()).join(' + ') : '—';

export const personName = (c: Contact) => `${c.them.firstName} ${c.them.lastName ?? ''}`.trim();

/** Цель кампании + сколько собрано по каждой валюте. */
export const progressLines = (prices: ListingPriceDto[], raised?: ContributionLine[]) => {
  const r = new Map((raised ?? []).map((x) => [x.currencyId, x.amount]));
  return prices.map((p) => ({ ...p, raised: r.get(p.currencyId) ?? 0 }));
};

export interface ListingAvailability {
  /** Скидка действует прямо сейчас. */
  discountActive: boolean;
  /** Цена со скидкой (или обычная, если скидки нет). */
  effPrices: ListingPriceDto[];
  /** Сколько осталось из штучного запаса (null = без лимита). */
  remaining: number | null;
  soldOut: boolean;
  notYet: boolean;
  closed: boolean;
  /** Можно купить/скинуться прямо сейчас. */
  sellable: boolean;
  /** Почему нельзя — короткой подписью. */
  reason: string;
}

/** Одно место правды про «продаётся ли лот сейчас» — карточка и формы читают его. */
export function listingAvailability(l: Listing, now = Date.now()): ListingAvailability {
  const discountActive =
    !!l.discountPercent && l.discountPercent > 0 && !!l.discountUntil && now < new Date(l.discountUntil).getTime();
  const effPrices = discountActive
    ? l.prices.map((p) => ({ ...p, amount: Math.max(1, Math.floor((p.amount * (100 - l.discountPercent!)) / 100)) }))
    : l.prices;
  const remaining = l.stockLimit != null ? Math.max(0, l.stockLimit - l.stockSold) : null;
  const soldOut = l.stockLimit != null && l.stockSold >= l.stockLimit;
  const notYet = !!l.availableFrom && now < new Date(l.availableFrom).getTime();
  const closed = !!l.availableUntil && now > new Date(l.availableUntil).getTime();
  const sellable = l.status === 'active' && !soldOut && !notYet && !closed;
  const reason = soldOut ? 'Распродано' : closed ? 'Закрыто' : notYet ? 'Скоро' : 'Недоступно';
  return { discountActive, effPrices, remaining, soldOut, notYet, closed, sellable, reason };
}

/** Подписи статусов заказа — одна карта на «Заказы» и rich-карточки. */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  funding: 'Идёт сбор',
  pending: 'Ждёт подтверждения',
  confirmed: 'В работе',
  settled: 'Завершён',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
  refunded: 'Возвращён',
};

export const ORDER_STATUS_TONE: Record<string, Tone> = {
  // «Идёт сбор» и «Ждёт подтверждения» — ожидание, а не предупреждение.
  funding: 'waiting',
  pending: 'waiting',
  confirmed: 'accent',
  settled: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  refunded: 'neutral',
};

/** Дней → ISO-срок от «сейчас» (окна продаж и скидок задаются в днях). */
export const daysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
