import { Injectable, OnModuleInit } from '@nestjs/common';
import type { MessengerServerToClientEvents, WsCursorInput, WsTypingInput } from '@superapp/shared';
import { RealtimeRegistry, type ClientEventContext } from '../../core/realtime/realtime.registry';
import { MessengerService } from './messenger.service';
import { PresenceService } from './presence.service';

/**
 * Доменное событие шины → имя события сокета. `satisfies` держит правую колонку в
 * рамках объявленной карты: опечатка в имени события — ошибка сборки.
 */
const RELAY_MAP = {
  'messenger.message.created': 'message:new',
  'messenger.message.updated': 'message:updated',
  'messenger.message.deleted': 'message:deleted',
  'messenger.receipt': 'receipt',
  'messenger.call.state': 'call:state',
} as const satisfies Record<string, keyof MessengerServerToClientEvents>;

/**
 * Мессенджер на движке core/realtime: relay `messenger.*` (сообщения, квитанции,
 * звонки, presence-пинг), клиентские хендлеры (delivered/read/heartbeat/typing) и
 * presence-хук соединения. Гейтвея у мессенджера больше нет — сокет один на платформу.
 */
@Injectable()
export class MessengerRealtimeProvider implements OnModuleInit {
  constructor(
    private readonly realtime: RealtimeRegistry,
    private readonly messenger: MessengerService,
    private readonly presence: PresenceService,
  ) {}

  onModuleInit(): void {
    this.realtime.registerRelay('messenger.*', ({ type, payload }) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      // Presence-пинг уходит заранее посчитанной аудитории (контакты + сам), не членам чата.
      if (type === 'messenger.presence.changed') {
        const audienceIds = (p.audienceIds as string[] | undefined) ?? [];
        if (!audienceIds.length) return null;
        return { rooms: audienceIds.map((id) => `user:${id}`), name: 'presence:changed', payload: { userId: p.userId } };
      }
      const memberIds = (p.memberUserIds as string[] | undefined) ?? [];
      if (!memberIds.length) return null;
      const name = (RELAY_MAP as Record<string, string | undefined>)[type];
      if (!name) return null;
      return { rooms: memberIds.map((id) => `user:${id}`), name, payload };
    });

    this.realtime.registerHandler('message:delivered', {
      rateLimit: { limit: 120 },
      handler: async ({ userId }, data) => {
        const d = data as WsCursorInput | undefined;
        if (!d?.chatId) return;
        await this.messenger.markDelivered(userId, d.chatId, Number(d.seq) || 0);
      },
    });
    this.realtime.registerHandler('message:read', {
      rateLimit: { limit: 120 },
      handler: async ({ userId }, data) => {
        const d = data as WsCursorInput | undefined;
        if (!d?.chatId) return;
        await this.messenger.markRead(userId, d.chatId, Number(d.seq) || 0);
      },
    });
    // ~25с каденс → 12/мин с запасом
    this.realtime.registerHandler('heartbeat', {
      rateLimit: { limit: 12 },
      handler: async ({ userId }) => this.presence.heartbeat(userId),
    });
    const typing = (isTyping: boolean) => async ({ socket, userId }: ClientEventContext, data: unknown) => {
      const d = data as WsTypingInput | undefined;
      if (!d?.chatId) return;
      try {
        const audience = await this.messenger.typingAudience(userId, d.chatId);
        if (!audience || !audience.length) return;
        // Мимо самого печатающего: socket.to() исключает отправителя, комнаты — адресаты
        (socket.to(audience.map((id) => `user:${id}`)).emit as (n: string, p: unknown) => boolean)('typing', { chatId: d.chatId, userId, typing: isTyping });
      } catch {
        // transient — ignore
      }
    };
    this.realtime.registerHandler('typing:start', { rateLimit: { limit: 60 }, handler: typing(true) });
    this.realtime.registerHandler('typing:stop', { rateLimit: { limit: 60 }, handler: typing(false) });

    this.realtime.registerConnectionHook({
      onConnect: async ({ userId }) => {
        await this.presence.onConnect(userId);
        await this.presence.fanOutPresenceChange(userId);
      },
      onDisconnect: async ({ userId }) => {
        await this.presence.onDisconnect(userId);
        await this.presence.fanOutPresenceChange(userId);
      },
    });
  }
}
