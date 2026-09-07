import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRegistry } from './realtime.registry';
import { RealtimeService } from './realtime.service';

/**
 * core/realtime — 18-й платформенный движок: один сокет платформы (`/realtime`).
 * Комнаты `user:<id>`, Redis-адаптер, handshake-авторизация, разрыв при отзыве
 * сессий. Фичи регистрируют relay (шина → сокет), клиентские хендлеры и хуки
 * соединения в RealtimeRegistry — движок фичи не импортирует.
 */
@Global()
@Module({
  providers: [RealtimeRegistry, RealtimeGateway, RealtimeService],
  exports: [RealtimeRegistry, RealtimeService],
})
export class RealtimeModule {}
