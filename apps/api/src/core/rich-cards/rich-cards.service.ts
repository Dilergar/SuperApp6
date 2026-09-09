import { Injectable } from '@nestjs/common';
import type {
  RichCardPayload,
  ExecuteRichCardActionResult,
  RichCardRefType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, forbidden, notFound } from '../../shared/errors/api-error';
import { NotificationChannelRegistry } from '../notifications/notifications.registry';
import { AccessService } from '../access/access.service';
import { RichCardRegistry } from './rich-cards.registry';
import type { RichCardDeps } from './rich-card.types';

/** Minimal surface RichCardsService needs from MessengerService (resolved lazily, no cycle). */

/**
 * Central dispatcher for interactive rich cards (Phase 3). Renderers + action handlers are
 * supplied by feature services via the RichCardRegistry, so this core service never imports a
 * feature module. MessengerService (for sharing a card into a chat) is resolved lazily through
 * ModuleRef to avoid a load-order / circular dependency (@Global core ⟶ feature service).
 */
@Injectable()
export class RichCardsService {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly channels: NotificationChannelRegistry,
  ) {}

  private deps(): RichCardDeps {
    return { db: this.db, access: this.access };
  }

  private user(id: string) {
    return { type: 'user', id };
  }

  /** Build the live card for a viewer, or null if missing / no access. */
  async render(viewerId: string, refType: string, refId: string): Promise<RichCardPayload | null> {
    const renderer = this.registry.getRenderer(refType);
    if (!renderer) return null;
    return renderer(this.deps(), viewerId, refId);
  }

  /**
   * Execute an action key against an entity. Re-checks the action's required capability on the
   * engine (the handler may do finer domain checks too), runs the handler, then re-renders the
   * card for the actor so the caller can reflect the new state.
   */
  async execute(
    userId: string,
    actionKey: string,
    ref: { type: RichCardRefType; id: string },
    payload?: Record<string, unknown>,
  ): Promise<ExecuteRichCardActionResult> {
    const def = this.registry.getAction(actionKey);
    if (!def) throw forbidden('richCard.unknownAction');

    if (def.requiredCapability) {
      const ok = await this.access.can(this.user(userId), def.requiredCapability, ref.id);
      if (!ok) throw forbidden('richCard.actionForbidden');
    }

    await def.handler(userId, ref.id, payload);

    const card = await this.render(userId, ref.type, ref.id);
    if (!card) {
      // Action may have closed/removed the entity, or revoked the actor's view (e.g. cancel).
      throw notFound('richCard.goneAfterAction');
    }
    return { card };
  }

  /**
   * Share an entity's card into a chat. The user must be able to BOTH view the chat
   * (chat.view) AND view the entity (render returns non-null). Posts a rich_card message.
   */
  async shareToChat(
    userId: string,
    chatId: string,
    refType: RichCardRefType,
    refId: string,
  ): Promise<RichCardPayload> {
    const canChat = await this.access.can(this.user(userId), 'chat.view', chatId);
    if (!canChat) throw forbidden('richCard.noChatAccess');

    const card = await this.render(userId, refType, refId);
    if (!card) throw forbidden('richCard.noCardAccess');

    // Чат — канал доставки движка уведомлений: драйвер регистрирует мессенджер, ленивого
    // токена на фичу у движка больше нет (ребро core/rich-cards → modules/messenger закрыто).
    const chat = this.channels.chat();
    if (!chat?.live) throw badRequest('notification.chat.notConfigured');
    const res = await chat.post({
      chatId,
      eventId: `share:${refType}:${refId}:${userId}:${Date.now()}`,
      type: 'rich_card',
      text: card.title,
      payload: {},
      href: card.href ?? null,
      ref: { type: refType, id: refId },
      richCardType: refType,
      actorId: userId,
    });
    if (!res.ok) throw badRequest('notification.chat.notConfigured');
    return card;
  }
}
