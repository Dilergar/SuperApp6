import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { EventBusService } from '../../shared/events/event-bus.service';
import { MessengerService } from './messenger.service';
import { PresenceService } from './presence.service';

/**
 * Realtime channel for the messenger. Auth happens on the socket handshake (JWT).
 * Each user joins a personal room `user:<id>`; domain `messenger.*` events are
 * fanned out to members' rooms via socket.io (+ Redis adapter across instances).
 *
 * Phase 4 adds presence (online/last-seen via PresenceService + heartbeat) and a
 * transient typing relay (no persistence).
 */
@WebSocketGateway({
  namespace: '/messenger',
  cors: { origin: ['http://localhost:3000', 'http://localhost:8081'], credentials: true },
})
export class MessengerGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger('MessengerGateway');

  @WebSocketServer() server!: Server;

  constructor(
    private jwt: JwtService,
    private events: EventBusService,
    private messenger: MessengerService,
    private presence: PresenceService,
  ) {}

  onModuleInit(): void {
    this.events.onPattern('messenger.*').subscribe((e) => {
      try {
        this.relay(e.type, e.payload as Record<string, any>);
      } catch (err) {
        this.logger.error(`relay ${e.type} failed`, err as Error);
      }
    });
    // logout-all / account deletion: socket auth is handshake-only, so revoked sessions
    // must be hard-disconnected. disconnectSockets() propagates across instances via the
    // Redis adapter, so ONE consumer of the event is enough.
    this.events.onPattern('auth.sessions.revoked').subscribe((e) => {
      const userId = (e.payload as { userId?: string })?.userId;
      if (!userId || !this.server) return;
      try {
        this.server.in(`user:${userId}`).disconnectSockets(true);
      } catch (err) {
        this.logger.error(`disconnect sockets for ${userId} failed`, err as Error);
      }
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = client.handshake.auth as { token?: string } | undefined;
      const header = client.handshake.headers?.authorization;
      const token = auth?.token || (header ? header.replace(/^Bearer\s+/i, '') : undefined);
      if (!token) throw new Error('no token');
      const payload = this.jwt.verify(token, {
        secret: process.env.JWT_SECRET,
      }) as { sub: string };
      client.data.userId = payload.sub;
      await client.join(`user:${payload.sub}`);
      // Presence: count this connection + tell contacts I may now be online.
      await this.presence.onConnect(payload.sub);
      await this.presence.fanOutPresenceChange(payload.sub);
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId) return;
    // Personal-room membership drops automatically on disconnect; update presence.
    await this.presence.onDisconnect(userId);
    await this.presence.fanOutPresenceChange(userId);
  }

  private relay(type: string, payload: Record<string, any>): void {
    if (!this.server) return;

    // Presence ping is fanned to a precomputed audience (contacts + self), not chat members.
    if (type === 'messenger.presence.changed') {
      const audienceIds: string[] = payload?.audienceIds ?? [];
      if (!audienceIds.length) return;
      const rooms = audienceIds.map((id) => `user:${id}`);
      this.server.to(rooms).emit('presence:changed', { userId: payload.userId });
      return;
    }

    const memberIds: string[] = payload?.memberUserIds ?? [];
    if (!memberIds.length) return;
    const event =
      type === 'messenger.message.created'
        ? 'message:new'
        : type === 'messenger.message.updated'
          ? 'message:updated'
          : type === 'messenger.message.deleted'
            ? 'message:deleted'
            : type === 'messenger.receipt'
              ? 'receipt'
              : null;
    if (!event) return;
    const rooms = memberIds.map((id) => `user:${id}`);
    this.server.to(rooms).emit(event, payload);
  }

  /**
   * Primitive per-socket token bucket: WS events bypass the HTTP ThrottlerGuard, so without
   * this a client could spam typing/heartbeat (each costs an access check + member query).
   * Counters live on the socket — no shared state needed (the limit is per connection).
   */
  private allow(client: Socket, kind: string, limit: number, windowMs = 60_000): boolean {
    const buckets = (client.data.rate ??= {} as Record<string, { n: number; resetAt: number }>);
    const now = Date.now();
    const b = buckets[kind];
    if (!b || now >= b.resetAt) {
      buckets[kind] = { n: 1, resetAt: now + windowMs };
      return true;
    }
    if (b.n >= limit) return false;
    b.n++;
    return true;
  }

  @SubscribeMessage('message:delivered')
  async onDelivered(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatId: string; seq: number },
  ): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId || !data?.chatId) return;
    if (!this.allow(client, 'receipt', 120)) return;
    await this.messenger.markDelivered(userId, data.chatId, Number(data.seq) || 0);
  }

  @SubscribeMessage('message:read')
  async onRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatId: string; seq: number },
  ): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId || !data?.chatId) return;
    if (!this.allow(client, 'receipt', 120)) return;
    await this.messenger.markRead(userId, data.chatId, Number(data.seq) || 0);
  }

  // ============================================================
  // Presence heartbeat (client → server every ~25s)
  // ============================================================
  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() client: Socket): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId) return;
    if (!this.allow(client, 'heartbeat', 12)) return; // ~25s cadence → 12/min is generous
    await this.presence.heartbeat(userId);
  }

  // ============================================================
  // Typing relay (transient; no persistence)
  // ============================================================
  @SubscribeMessage('typing:start')
  async onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatId: string },
  ): Promise<void> {
    if (!this.allow(client, 'typing', 60)) return;
    await this.relayTyping(client, data?.chatId, true);
  }

  @SubscribeMessage('typing:stop')
  async onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { chatId: string },
  ): Promise<void> {
    if (!this.allow(client, 'typing', 60)) return;
    await this.relayTyping(client, data?.chatId, false);
  }

  private async relayTyping(client: Socket, chatId: string | undefined, typing: boolean): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId || !chatId) return;
    try {
      const audience = await this.messenger.typingAudience(userId, chatId);
      if (!audience || !audience.length) return; // no access or no other members
      const rooms = audience.map((id) => `user:${id}`);
      this.server.to(rooms).emit('typing', { chatId, userId, typing });
    } catch {
      // transient — ignore failures
    }
  }
}
