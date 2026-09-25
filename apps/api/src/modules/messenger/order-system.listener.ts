import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { DatabaseService } from '../../shared/database/database.service';
import { MessengerService } from './messenger.service';

/**
 * Bridges shop order-lifecycle events onto the order's CONTEXT chat as system plaques.
 * Best-effort — a failure here never affects the shop operation.
 *
 *  - On EVERY shop.order.* event: resync the order's access tuples (idempotent), so a
 *    contribute/withdraw that changed the contributor set is reflected (no extra shop emit
 *    needed).
 *  - shop.order.funded (crowdfunding goal reached): create the campaign chat eagerly + plaque,
 *    so all contributors land in a shared chat awaiting confirmation.
 *  - confirmed / rejected / cancelled: plaque ONLY if a chat already exists (a normal order may
 *    have none — its chat is created on demand via getOrderChat / the 'listing.talk' DM path).
 *
 * Плашки структурные (ключ типа): текст собирается при чтении в языке зрителя.
 *
 * Lives in the messenger module (depends only on EventBus + AccessProjection + DB + Messenger —
 * no cycle). Separate from the notifications listener.
 */
@Injectable()
export class OrderSystemListener implements OnModuleInit {
  private readonly logger = new Logger(OrderSystemListener.name);

  constructor(
    private readonly events: EventBusService,
    private readonly projection: AccessProjectionService,
    private readonly db: DatabaseService,
    private readonly messenger: MessengerService,
  ) {}

  onModuleInit() {
    this.events.onPattern('shop.order.*').subscribe((e) => {
      void this.handle(e.type, (e.payload ?? {}) as OrderEventPayload);
    });
  }

  private async handle(type: string, p: OrderEventPayload): Promise<void> {
    try {
      const orderId = p.orderId;
      if (!orderId) return;

      // Always keep the order's access edges in sync (covers contribute/withdraw too).
      await this.projection.resyncOrderRoles(orderId);

      if (type === 'shop.order.funded') {
        // Campaign fully collected → ensure the shared chat exists with all contributors.
        await this.messenger.syncOrderChatMembers(orderId);
        await this.messenger.postOrderSystemMessage(orderId, 'order.funded', { typeKey: 'order.collecting_done' });
        return;
      }

      const typeKey = this.typeKeyFor(type);
      if (!typeKey) return; // event type we don't render as a plaque

      // Plaque only if a chat already exists; never create one here for normal orders.
      const chat = await this.db.chat.findFirst({
        where: { parentType: 'order', parentId: orderId },
        select: { id: true },
      });
      if (!chat) return;
      await this.messenger.syncOrderChatMembers(orderId);
      await this.messenger.postOrderSystemMessage(orderId, type, { typeKey });
    } catch (err) {
      this.logger.warn(
        `order system message failed (non-fatal): ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  /** Ключ плашки (`chatter.type.<key>`) на событие shop.order.*, или null — плашки нет. */
  private typeKeyFor(type: string): string | null {
    switch (type) {
      case 'shop.order.confirmed':
        return 'order.confirmed';
      case 'shop.order.rejected':
        return 'order.rejected';
      case 'shop.order.cancelled':
        return 'order.cancelled';
      default:
        return null;
    }
  }
}

interface OrderEventPayload {
  orderId?: string;
  sellerId?: string;
  buyerId?: string;
  title?: string;
  [key: string]: unknown;
}
