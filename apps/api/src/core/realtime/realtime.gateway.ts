import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { RealtimeClientToServerEvents, RealtimeServerToClientEvents } from '@superapp/shared';
import { SessionValidatorService } from '../../shared/auth/session-validator.service';
import { isAllowedWebOrigin } from '../../shared/config/web-origins';
import { EventBusService } from '../../shared/events/event-bus.service';
import { RealtimeRegistry } from './realtime.registry';

/**
 * core/realtime — ОДИН сокет платформы (namespace `/realtime`): рукопожатие с
 * паритетом HTTP (подпись + срок + отзыв сессии + удалённый аккаунт), личные комнаты
 * `user:<id>`, Redis-адаптер (main.ts), разрыв при `auth.sessions.revoked`.
 * Что слать и что принимать — знают фичи: мессенджер и уведомления регистрируют
 * relay/хендлеры/хуки в RealtimeRegistry. Подписки на шину — после бутстрапа всех
 * модулей (регистрации идут в их onModuleInit).
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    // Список общий с HTTP-CORS и frame-ancestors (shared/config/web-origins.ts). Функция,
    // а не массив: декоратор вычисляется при ИМПОРТЕ файла, а `WEB_URL` нужен прод-адресу
    // в момент рукопожатия — массив зафиксировал бы только адреса разработки.
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, isAllowedWebOrigin(origin)),
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationBootstrap {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server<RealtimeClientToServerEvents, RealtimeServerToClientEvents>;

  constructor(
    private readonly sessions: SessionValidatorService,
    private readonly events: EventBusService,
    private readonly registry: RealtimeRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const patterns = new Map<string, number>();
    for (const relay of this.registry.allRelays()) {
      patterns.set(relay.busPattern, (patterns.get(relay.busPattern) ?? 0) + 1);
    }
    for (const pattern of patterns.keys()) {
      const source = pattern.includes('*') ? this.events.onPattern(pattern) : this.events.on(pattern);
      source.subscribe((e) => {
        for (const relay of this.registry.allRelays()) {
          if (relay.busPattern !== pattern) continue;
          try {
            const out = relay.map({ type: e.type, payload: e.payload });
            for (const emit of Array.isArray(out) ? out : out ? [out] : []) {
              if (emit.rooms.length) this.emitRaw(emit.rooms, emit.name, emit.payload);
            }
          } catch (err) {
            this.logger.error(`relay ${e.type} failed`, err as Error);
          }
        }
      });
    }
    // logout-all / удаление аккаунта: авторизация сокета — только на рукопожатии, поэтому
    // отозванные сессии рвём жёстко. disconnectSockets() уходит через Redis-адаптер на все
    // инстансы — ОДНОГО подписчика достаточно.
    this.events.onPattern('auth.sessions.revoked').subscribe((e) => {
      const userId = (e.payload as { userId?: string })?.userId;
      if (!userId || !this.server) return;
      try {
        this.server.in(`user:${userId}`).disconnectSockets(true);
      } catch (err) {
        this.logger.error(`disconnect sockets for ${userId} failed`, err as Error);
      }
    });
    // Точечный отзыв (завершить одну сессию, забыть устройство, выход, отзыв Кабинетом, неактивность):
    // рвём сокеты ТОЛЬКО этих семейств — иначе завершённая на украденном устройстве сессия
    // продолжала бы получать сообщения и уведомления по живому сокету до его разрыва
    this.events.onPattern('auth.families.revoked').subscribe((e) => {
      const families = (e.payload as { families?: unknown })?.families;
      if (!Array.isArray(families) || !families.length || !this.server) return;
      const rooms = families.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 64).map((f) => `fam:${f}`);
      if (!rooms.length) return;
      try {
        this.server.in(rooms).disconnectSockets(true);
      } catch (err) {
        this.logger.error(`disconnect sockets of ${rooms.length} revoked session families failed`, err as Error);
      }
    });
    this.logger.log(`realtime: relays ${this.registry.allRelays().length} (${[...patterns.keys()].join(', ')})`);
  }

  /** Доставить событие в комнаты (для сервисов движка и relay). */
  emitRaw(rooms: string[], name: string, payload: unknown): void {
    if (!this.server || !rooms.length) return;
    // ЕДИНСТВЕННЫЙ узаконенный каст канала: формы enforced на emit-САЙТАХ фич (литералы
    // объявлены Ws*-типами), здесь остаётся только доставка.
    (this.server.to(rooms).emit as (ev: string, p: unknown) => boolean)(name, payload);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = client.handshake.auth as { token?: string } | undefined;
      const header = client.handshake.headers?.authorization;
      const token = auth?.token || (header ? header.replace(/^Bearer\s+/i, '') : undefined);
      if (!token) throw new Error('no token');
      // Шлюз согласий — тем же валидатором: человек за блокирующим экраном сокет не открывает
      const payload = await this.sessions.verifyAccessToken(token, { enforceConsents: true });
      client.data.userId = payload.sub;
      client.data.epoch = payload.epoch ?? 0;
      await client.join(`user:${payload.sub}`);
      // Комната семейства сессии — точечный разрыв при её отзыве (`auth.families.revoked`)
      if (payload.fam) await client.join(`fam:${payload.fam}`);

      // Клиентские события — через реестр (динамические хендлеры вместо декораторов).
      client.onAny((event: string, data: unknown) => {
        const def = this.registry.handler(event);
        if (!def) return;
        if (def.rateLimit && !this.allow(client, event, def.rateLimit.limit, def.rateLimit.windowMs ?? 60_000)) return;
        Promise.resolve(def.handler({ socket: client, userId: payload.sub }, data)).catch((err) =>
          this.logger.warn(`handler ${event} failed: ${(err as Error).message}`),
        );
      });

      // Хук фичи (presence мессенджера) ходит в Redis. Его сбой — НЕ повод рвать сокет:
      // уведомления и лента сообщений жили бы дальше, а тут человек остался бы вообще без
      // realtime. Ошибку хука ловим по-хуку, как это уже сделано на разрыве.
      for (const hook of this.registry.allHooks()) {
        try {
          await hook.onConnect?.({ socket: client, userId: payload.sub });
        } catch (err) {
          this.logger.warn(`onConnect hook failed: ${(err as Error).message}`);
        }
      }
    } catch {
      // Рукопожатие не прошло (нет токена / подпись / срок / отзыв сессии) — только разрыв
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    if (!userId) return;
    for (const hook of this.registry.allHooks()) {
      try {
        await hook.onDisconnect?.({ socket: client, userId });
      } catch (err) {
        this.logger.warn(`onDisconnect hook failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Пер-сокетный token-bucket: WS минует HTTP-троттлер, без него клиент мог бы
   * спамить typing/heartbeat (каждое — проверка прав + запрос членства).
   */
  private allow(client: Socket, kind: string, limit: number, windowMs: number): boolean {
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
}
