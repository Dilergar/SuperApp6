import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';

// ============================================================
// core/realtime — реестры (направление «фича → движок»): relay событий шины в
// комнаты сокета, обработчики клиентских событий, хуки соединения.
// ============================================================

/** Что отдать в сокет по событию шины: комнаты (`user:<id>`) + имя события + payload. Null — не слать. */
export interface RelayEmit {
  rooms: string[];
  name: string;
  payload: unknown;
}

/** Одно событие шины может дать несколько emit'ов (по адресату — свой payload). */
export type RelayMapper = (event: { type: string; payload: unknown }) => RelayEmit | RelayEmit[] | null;

export interface RelayDef {
  /** Паттерн шины: `messenger.*`, `notifications.created` */
  busPattern: string;
  map: RelayMapper;
}

/** Контекст клиентского события: сокет + кто (после рукопожатия). */
export interface ClientEventContext {
  socket: Socket;
  userId: string;
}

export interface ClientHandlerDef {
  handler: (ctx: ClientEventContext, data: unknown) => Promise<void> | void;
  /** Пер-сокетный token-bucket (WS минует HTTP-троттлер): событий в окне */
  rateLimit?: { limit: number; windowMs?: number };
}

export interface ConnectionHook {
  onConnect?: (ctx: ClientEventContext) => Promise<void> | void;
  onDisconnect?: (ctx: ClientEventContext) => Promise<void> | void;
}

@Injectable()
export class RealtimeRegistry {
  private readonly logger = new Logger(RealtimeRegistry.name);
  private readonly relays: RelayDef[] = [];
  private readonly handlers = new Map<string, ClientHandlerDef>();
  private readonly hooks: ConnectionHook[] = [];

  registerRelay(busPattern: string, map: RelayMapper): void {
    this.relays.push({ busPattern, map });
  }

  registerHandler(clientEvent: string, def: ClientHandlerDef): void {
    if (this.handlers.has(clientEvent)) this.logger.warn(`handler "${clientEvent}" already registered; overwriting`);
    this.handlers.set(clientEvent, def);
  }

  registerConnectionHook(hook: ConnectionHook): void {
    this.hooks.push(hook);
  }

  allRelays(): readonly RelayDef[] {
    return this.relays;
  }

  handler(clientEvent: string): ClientHandlerDef | undefined {
    return this.handlers.get(clientEvent);
  }

  allHooks(): readonly ConnectionHook[] {
    return this.hooks;
  }
}
