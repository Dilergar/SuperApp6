import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service';
import {
  NotificationChannelRegistry,
  NotificationRefRegistry,
  PresenceProviderRegistry,
  type ChatPostInput,
  type ChatPostResult,
} from '../../core/notifications/notifications.registry';
import { RichCardsService } from '../../core/rich-cards/rich-cards.service';
import { MessengerService } from './messenger.service';
import { PresenceService } from './presence.service';

/**
 * Мессенджер → движок уведомлений (направление «фича → движок»):
 * - presence-провайдер: «онлайн в вебе» откладывает push на 2 минуты (Linear/Notion);
 * - резолверы `chat` / `chat_message`: адресат видит объект = активный член чата;
 * - канал `chat`: объект-получатель — чат. Есть рич-карта и актор → живая карточка от
 *   актора (как «Поделиться в чат»); иначе — системное сообщение (authorId=null, как плашки
 *   хроники: в непрочитанное чата не попадает, текст перерисовывается в языке читателя).
 *   Этим же драйвером пользуется `rich-cards.shareToChat` — ребро core/rich-cards →
 *   modules/messenger исчезло.
 */
@Injectable()
export class MessengerNotificationsProvider implements OnModuleInit {
  private readonly logger = new Logger(MessengerNotificationsProvider.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly presence: PresenceService,
    private readonly presenceRegistry: PresenceProviderRegistry,
    private readonly refs: NotificationRefRegistry,
    private readonly channels: NotificationChannelRegistry,
    private readonly messenger: MessengerService,
    private readonly richCards: RichCardsService,
  ) {}

  onModuleInit(): void {
    this.presenceRegistry.register({ isOnline: (ids) => this.presence.onlineOf(ids) });

    this.refs.register('chat', {
      canViewMany: (userIds, chatId) => this.activeMembers(chatId, userIds),
      href: (ref) => `/messenger?chat=${ref.id}`,
    });
    this.refs.register('chat_message', {
      canViewMany: async (userIds, messageId) => {
        const msg = await this.db.message.findUnique({ where: { id: messageId }, select: { chatId: true } });
        if (!msg) return [];
        return this.activeMembers(msg.chatId, userIds);
      },
      // Адрес сообщения знает продюсер (actionUrl); по одному id чата не найти без запроса
      href: () => null,
    });

    this.channels.registerChat({
      live: true,
      post: (input) => this.postToChat(input),
    });
  }

  private async postToChat(input: ChatPostInput): Promise<ChatPostResult> {
    const chat = await this.db.chat.findUnique({ where: { id: input.chatId }, select: { id: true } });
    if (!chat) return { ok: false, gone: true, error: 'chat_not_found' };
    try {
      if (input.richCardType && input.ref && input.actorId) {
        const card = await this.richCards.render(input.actorId, input.richCardType, input.ref.id);
        if (card) {
          const msg = await this.messenger.postRichCard(input.chatId, card, input.actorId);
          return { ok: true, messageId: msg.id };
        }
      }
      const id = await this.messenger.postNotificationMessage(input.chatId, {
        type: input.type,
        text: input.text,
        payload: input.payload,
        href: input.href,
        ref: input.ref,
        eventId: input.eventId,
      });
      return { ok: true, messageId: id };
    } catch (e) {
      this.logger.warn(`chat post ${input.chatId} failed: ${(e as Error).message}`);
      return { ok: false, error: (e as Error).message };
    }
  }

  private async activeMembers(chatId: string, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await this.db.chatMember.findMany({
      where: { chatId, userId: { in: userIds }, leftAt: null },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
