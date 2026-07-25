import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import type { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Единственный источник правды о живости сессии — общий для ВСЕХ транспортов.
 *
 * Кэш «аккаунт жив»: проверка выполняется на КАЖДЫЙ авторизованный HTTP-запрос
 * платформы — без кэша users была самой читаемой таблицей (перф-ревью 2026-07-18).
 * Кэшируем ТОЛЬКО положительный ответ (жив) на короткий TTL:
 *  - «мёртвый» аккаунт не кэшируется — редкий путь, и его access-токен умрёт сам (≤15 мин);
 *  - планирование удаления/анонимизация явно чистят ключ (см. UsersService), так что
 *    окно устаревания у «жив» ≤ TTL и только в момент удаления аккаунта;
 *  - Redis недоступен → честный фолбэк в БД (кэш никогда не является источником отказа).
 *
 * В кэше лежит НЕ флаг, а актуальное поколение токенов (users.token_epoch): отзыв
 * сессий (сброс/смена пароля, смена номера, logout-all) инкрементирует поколение и
 * чистит ключ, после чего каждый старый access-токен получает 401 на первом же
 * запросе. Без этого «все сессии отозваны» означало лишь удаление строк session, а
 * украденный токен жил ещё до 15 минут — ровно те минуты, ради которых пароль и меняют.
 *
 * Почему это вынесено из JwtStrategy: раньше проверка жила только на HTTP-пути, а
 * рукопожатие веб-сокета проверяло ТОЛЬКО подпись. Отозванный токен не проходил в HTTP,
 * но открывал сокет и продолжал получать переписку до истечения своих 15 минут —
 * socket.io переподключается сам, поэтому «выброс» живых сокетов по событию эту дыру
 * не закрывал. Теперь оба входа обязаны идти сюда.
 */
const ALIVE_TTL_SECONDS = 60;
export const authAliveKey = (userId: string) => `auth:alive:${userId}`;

@Injectable()
export class SessionValidatorService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private jwt: JwtService,
  ) {}

  /**
   * Живость по УЖЕ РАСПАКОВАННОМУ payload — подпись проверил вызывающий
   * (на HTTP это делает passport-jwt до вызова strategy.validate).
   */
  async assertAlive(payload: JwtPayload): Promise<JwtPayload> {
    const key = authAliveKey(payload.sub);
    const tokenEpoch = payload.epoch ?? 0;
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        if (Number(cached) !== tokenEpoch) {
          throw new UnauthorizedException('Сессия завершена, войдите снова');
        }
        return payload;
      }
    } catch (err) {
      // ВАЖНО: отзыв не должен выглядеть как сбой Redis — пробрасываем как есть.
      if (err instanceof UnauthorizedException) throw err;
      /* Redis недоступен — проверяем в БД */
    }

    // Verify user still exists.
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, deletedAt: true, deletionScheduledAt: true, tokenEpoch: true },
    });

    // Block both permanently-anonymized and grace-window (pending) accounts —
    // a pending account is "gone" until the user logs in again to restore it.
    if (!user || user.deletedAt || user.deletionScheduledAt) {
      throw new UnauthorizedException('Пользователь не найден');
    }

    try {
      await this.redis.set(key, String(user.tokenEpoch), ALIVE_TTL_SECONDS);
    } catch {
      /* кэш — best-effort */
    }

    // Токен из прошлого поколения — отозван (смена пароля/номера, выход везде).
    if (user.tokenEpoch !== tokenEpoch) {
      throw new UnauthorizedException('Сессия завершена, войдите снова');
    }

    return payload;
  }

  /**
   * Подпись + срок, затем живость. Вход для НЕ-HTTP транспортов (рукопожатие сокета).
   * Секрет читается на каждый вызов, а не на импорте модуля: модульные env-константы
   * вычисляются ДО validateEnv() в main.ts.
   */
  async verifyAccessToken(raw: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(raw, { secret: process.env.JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Недействительный токен');
    }
    if (!payload?.sub) throw new UnauthorizedException('Недействительный токен');
    return this.assertAlive(payload);
  }

  /**
   * Поколение ТОЛЬКО из кэша (null = ключа нет). Для дешёвой пере-проверки уже
   * открытого сокета: промах кэша отдаём как «не знаю», а не как отказ — платить
   * запросом в БД на каждый heartbeat каждого сокета мы не готовы.
   */
  async cachedEpoch(userId: string): Promise<number | null> {
    try {
      const cached = await this.redis.get(authAliveKey(userId));
      return cached === null ? null : Number(cached);
    } catch {
      return null;
    }
  }
}
