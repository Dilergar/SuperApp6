import { Injectable, OnModuleInit } from '@nestjs/common';
import type {
  ContributionLine,
  RichCardAction,
  RichCardField,
  RichCardPayload,
} from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import { RichCardsService } from '../../core/rich-cards/rich-cards.service';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { DatabaseService } from '../../shared/database/database.service';
import { ShopService } from './shop.service';
import { MessengerService } from '../messenger/messenger.service';

const ORDER_STATUS_WORDS: Record<string, string> = {
  funding: 'Идёт сбор',
  pending: 'Ожидает подтверждения',
  confirmed: 'В работе',
  settled: 'Завершён',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
  refunded: 'Возвращён',
};

/** "120 / 200 🪙" style line per currency. */
function priceLine(amount: number, icon: string): string {
  return `${amount} ${icon}`;
}

/**
 * Registers shop rich-card renderers (order / listing / crowdfunding) + their action handlers.
 * Buttons are permission/state-filtered for the viewer; actions delegate to ShopService (which
 * re-checks its own gating). 'listing.talk' opens a buyer↔seller DM and posts the listing card —
 * needs MessengerService, so ShopModule imports MessengerModule (one-directional).
 */
@Injectable()
export class ShopRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly db: DatabaseService,
    private readonly shop: ShopService,
    private readonly messenger: MessengerService,
    private readonly richCards: RichCardsService,
  ) {}

  onModuleInit() {
    this.registry.registerRenderer('order', (deps, viewerId, refId) => this.renderOrder(deps, viewerId, refId));
    this.registry.registerRenderer('listing', (deps, viewerId, refId) => this.renderListing(deps, viewerId, refId, false));
    this.registry.registerRenderer('crowdfunding', (deps, viewerId, refId) => this.renderListing(deps, viewerId, refId, true));

    // Orders — capability is the engine floor; the service re-checks buyer/seller + state.
    this.registry.registerAction('order.confirm', {
      requiredCapability: 'order.manage',
      handler: (userId, refId) => this.shop.confirmOrder(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('order.reject', {
      requiredCapability: 'order.manage',
      handler: (userId, refId) => this.shop.rejectOrder(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('order.cancel', {
      // no cap: the service verifies the actor is the buyer.
      handler: (userId, refId) => this.shop.cancelOrder(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('order.refund', {
      requiredCapability: 'order.manage',
      handler: (userId, refId) => this.shop.refundOrder(userId, refId).then(() => undefined),
    });

    // Listing / crowdfunding — refId is the listing id; the service checks showcase.view.
    this.registry.registerAction('listing.buy', {
      handler: (userId, refId) => this.shop.buy(userId, refId).then(() => undefined),
    });
    this.registry.registerAction('crowdfunding.contribute', {
      handler: (userId, refId, payload) =>
        this.shop
          .contribute(userId, refId, ((payload?.lines as ContributionLine[]) ?? []))
          .then(() => undefined),
    });
    this.registry.registerAction('crowdfunding.withdraw', {
      // withdraw operates on the campaign (Order) id. A crowdfunding card's ref.id is the LISTING,
      // so the button carries the active campaign id in payload.orderId; fall back to refId in case
      // the caller already passed an order id.
      handler: (userId, refId, payload) =>
        this.shop.withdraw(userId, (payload?.orderId as string) ?? refId).then(() => undefined),
    });
    this.registry.registerAction('listing.talk', {
      handler: (userId, refId) => this.openTalk(userId, refId),
    });
  }

  // ============================================================
  // listing.talk — open a buyer↔seller DM and drop the listing card in
  // ============================================================
  private async openTalk(buyerId: string, listingId: string): Promise<void> {
    const listing = await this.db.listing.findUnique({
      where: { id: listingId },
      select: { showcaseId: true, showcase: { select: { shop: { select: { ownerType: true, ownerId: true } } } } },
    });
    if (!listing) return;
    // The viewer must be able to see the showcase to start a conversation about its item.
    if (!(await this.shop.canViewShowcaseForCard(buyerId, listing.showcaseId))) return;
    const shop = listing.showcase.shop;
    if (shop.ownerType !== 'user') return; // DM only makes sense for a personal seller
    const sellerId = shop.ownerId;
    if (sellerId === buyerId) return;

    const chat = await this.messenger.openDm(buyerId, sellerId);
    const card = await this.richCards.render(buyerId, 'listing', listingId);
    if (card) await this.messenger.postRichCard(chat.id, card, buyerId);
  }

  // ============================================================
  // renderers
  // ============================================================
  private async renderOrder(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
  ): Promise<RichCardPayload | null> {
    if (!(await deps.access.can({ type: 'user', id: viewerId }, 'order.view', refId))) return null;
    const order = await deps.db.order.findUnique({
      where: { id: refId },
      select: {
        titleSnapshot: true,
        status: true,
        buyerId: true,
        sellerId: true,
        crowdfunding: true,
        prices: { select: { currencyId: true, amount: true } },
      },
    });
    if (!order) return null;

    const isSeller = order.sellerId === viewerId;
    const isBuyer = order.buyerId === viewerId;
    const currencies = await this.currencyIcons(order.prices.map((p) => p.currencyId));

    const fields: RichCardField[] = [
      { label: 'Статус', value: ORDER_STATUS_WORDS[order.status] ?? order.status },
      {
        label: 'Сумма',
        value:
          order.prices.map((p) => priceLine(Number(p.amount), currencies.get(p.currencyId) ?? '🪙')).join(', ') || '—',
      },
    ];

    const actions: RichCardAction[] = [];
    if (isSeller && order.status === 'pending') {
      actions.push({ key: 'order.confirm', label: 'Подтвердить', style: 'primary' });
      actions.push({ key: 'order.reject', label: 'Отклонить', style: 'danger' });
    }
    if (isBuyer && !order.crowdfunding && order.status === 'pending') {
      actions.push({ key: 'order.cancel', label: 'Отменить', style: 'danger' });
    }
    if (isSeller && order.status === 'confirmed') {
      actions.push({ key: 'order.refund', label: 'Вернуть', style: 'danger' });
    }

    return {
      kind: 'rich_card',
      cardType: 'order',
      ref: { type: 'order', id: refId },
      title: order.titleSnapshot,
      subtitle: ORDER_STATUS_WORDS[order.status] ?? null,
      icon: '🧾',
      imageUrl: null,
      fields,
      progress: null,
      status: ORDER_STATUS_WORDS[order.status] ?? null,
      actions,
      href: '/shop',
    };
  }

  /**
   * Listing card (asCampaign=false) or crowdfunding card (asCampaign=true). For a campaign the
   * progress is computed from the live active campaign's snapshotted goal vs raised contributions.
   */
  private async renderListing(
    deps: RichCardDeps,
    viewerId: string,
    refId: string,
    asCampaign: boolean,
  ): Promise<RichCardPayload | null> {
    const listing = await deps.db.listing.findUnique({
      where: { id: refId },
      select: {
        title: true,
        description: true,
        icon: true,
        status: true,
        crowdfunding: true,
        showcaseId: true,
        prices: { select: { currencyId: true, amount: true } },
        showcase: { select: { shop: { select: { ownerType: true, ownerId: true } } } },
      },
    });
    if (!listing) return null;

    const isOwner =
      listing.showcase.shop.ownerType === 'user' && listing.showcase.shop.ownerId === viewerId;
    const canView =
      isOwner || (await deps.access.can({ type: 'user', id: viewerId }, 'showcase.view', listing.showcaseId));
    if (!canView) return null;

    const currencies = await this.currencyIcons(listing.prices.map((p) => p.currencyId));
    const priceStr =
      listing.prices.map((p) => priceLine(Number(p.amount), currencies.get(p.currencyId) ?? '🪙')).join(', ') || '—';

    const fields: RichCardField[] = [{ label: 'Цена', value: priceStr }];
    const actions: RichCardAction[] = [];
    let progress: RichCardPayload['progress'] = null;

    if (asCampaign && listing.crowdfunding) {
      const campaign = await deps.db.order.findFirst({
        where: { listingId: refId, crowdfunding: true, status: { in: ['funding', 'pending'] } },
        select: {
          id: true,
          status: true,
          prices: { select: { currencyId: true, amount: true } },
          contributions: { select: { contributorId: true, currencyId: true, amount: true } },
        },
      });
      const goalTotal = campaign
        ? campaign.prices.reduce((s, p) => s + Number(p.amount), 0)
        : listing.prices.reduce((s, p) => s + Number(p.amount), 0);
      const raisedTotal = campaign
        ? campaign.contributions.reduce((s, c) => s + Number(c.amount), 0)
        : 0;
      progress = { current: raisedTotal, target: goalTotal, label: `${raisedTotal} / ${goalTotal}` };

      const iHavePledged =
        !!campaign && campaign.contributions.some((c) => c.contributorId === viewerId);
      const open = listing.status === 'active' && (!campaign || campaign.status === 'funding');
      if (!isOwner && open) {
        actions.push({ key: 'crowdfunding.contribute', label: 'Скинуться', style: 'primary' });
      }
      if (iHavePledged && campaign && campaign.status === 'funding') {
        // withdraw operates on the campaign (Order) id, not the listing.
        actions.push({ key: 'crowdfunding.withdraw', label: 'Отозвать вклад', style: 'danger', payload: { orderId: campaign.id } });
      }
    } else {
      if (!isOwner && listing.status === 'active' && !listing.crowdfunding) {
        actions.push({ key: 'listing.buy', label: 'Купить', style: 'primary' });
        actions.push({ key: 'listing.talk', label: 'Поговорить', style: 'default' });
      }
    }

    return {
      kind: 'rich_card',
      cardType: asCampaign ? 'crowdfunding' : 'listing',
      ref: { type: asCampaign ? 'crowdfunding' : 'listing', id: refId },
      title: listing.title,
      subtitle: listing.description ?? null,
      icon: listing.icon ?? (asCampaign ? '🤝' : '🛍️'),
      imageUrl: null,
      fields,
      progress,
      status: null,
      actions,
      href: '/shop',
    };
  }

  private async currencyIcons(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.currency.findMany({
      where: { id: { in: unique } },
      select: { id: true, icon: true },
    });
    return new Map(rows.map((c) => [c.id, c.icon]));
  }
}
