import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';

/**
 * Кэш «аккаунт жив»: JwtStrategy.validate выполняется на КАЖДЫЙ авторизованный
 * HTTP-запрос платформы — без кэша users была самой читаемой таблицей (перф-ревью
 * 2026-07-18). Кэшируем ТОЛЬКО положительный ответ (жив) на короткий TTL:
 *  - «мёртвый» аккаунт не кэшируется — редкий путь, и его access-токен умрёт сам (≤15 мин);
 *  - планирование удаления/анонимизация явно чистят ключ (см. UsersService), так что
 *    окно устаревания у «жив» ≤ TTL и только в момент удаления аккаунта;
 *  - Redis недоступен → честный фолбэк в БД (кэш никогда не является источником отказа).
 */
const ALIVE_TTL_SECONDS = 60;
export const authAliveKey = (userId: string) => `auth:alive:${userId}`;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const key = authAliveKey(payload.sub);
    try {
      if ((await this.redis.get(key)) === '1') return payload;
    } catch {
      /* Redis недоступен — проверяем в БД */
    }

    // Verify user still exists.
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, deletedAt: true, deletionScheduledAt: true },
    });

    // Block both permanently-anonymized and grace-window (pending) accounts —
    // a pending account is "gone" until the user logs in again to restore it.
    if (!user || user.deletedAt || user.deletionScheduledAt) {
      throw new UnauthorizedException('Пользователь не найден');
    }

    try {
      await this.redis.set(key, '1', ALIVE_TTL_SECONDS);
    } catch {
      /* кэш — best-effort */
    }

    // role in JWT = system role (from login/refresh), kept for fast checks
    return payload;
  }
}
