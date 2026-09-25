import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions, Server } from 'socket.io';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

/**
 * socket.io adapter backed by Redis so a `server.to(room).emit()` on ANY API instance reaches
 * that room's sockets on EVERY instance (horizontal scaling).
 *
 * Sharded Pub/Sub (Redis ≥ 7, SPUBLISH/SSUBSCRIBE): канал на комнату (`dynamic`) — событие
 * комнаты `user:<id>` получает только инстанс, где у человека открыт сокет, а не все процессы
 * кластера; в Redis Cluster канал живёт на шарде своего слота (классический PUBLISH рассылается
 * по ВСЕМ узлам кластера). Адаптер — инстанс СОСТОЯНИЯ (`REDIS_URL`): кэш-инстанс вытесняет.
 * Pub/Sub не хранит сообщений: пропущенное за разрыв клиент добирает через API (`onReconnect`).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RedisIoAdapter');
  private adapterConstructor?: ReturnType<typeof createShardedAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const pubClient = new Redis(url, { connectionName: 'superapp6-api:socket-pub' });
    const subClient = pubClient.duplicate({ connectionName: 'superapp6-api:socket-sub' });
    pubClient.on('error', (e) => this.logger.error('redis pub error', e));
    subClient.on('error', (e) => this.logger.error('redis sub error', e));
    this.adapterConstructor = createShardedAdapter(pubClient, subClient, { subscriptionMode: 'dynamic' });
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server: Server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
