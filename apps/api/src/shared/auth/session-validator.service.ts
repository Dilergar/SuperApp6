import { Injectable, UnauthorizedException } from '@nestjs/common';
import { forbidden, unauthorized } from '../errors/api-error';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { KeysSigningService } from '../../core/keys/keys.signing.service';
import { legacySecret } from '../../core/keys/keys.legacy';
import { ConsentsGateService } from '../../core/consents/gate/consents-gate.service';
import { CONSENT_ERROR_CODES } from '@superapp/shared';
import type { JwtPayload } from '../decorators/current-user.decorator';
import { AuditSessionsService, authFamilyRevokedKey } from '../../core/audit/audit.sessions.service';

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
 *
 * Рядом с поколением токенов в том же значении кэша едет ЭПОХА СОГЛАСИЙ человека
 * (`users.consent_epoch`, core/consents) — формат `<tokenEpoch>:<consentEpoch>`. Шлюз согласий
 * сравнивает её с глобальной без единого обращения к базе или Redis сверх уже сделанного.
 * Значение старого формата (без двоеточия, окно раскатки) читается как «эпоха неизвестна» —
 * шлюз проверит человека по базе.
 */
const ALIVE_TTL_SECONDS = 60;
export const authAliveKey = (userId: string) => `auth:alive:${userId}`;

@Injectable()
export class SessionValidatorService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private signing: KeysSigningService,
    private consentsGate: ConsentsGateService,
    private sessions: AuditSessionsService,
  ) {}

  /** Значение кэша → поколение токенов и эпоха согласий (старый формат — только поколение). */
  private parseCached(cached: string): { tokenEpoch: number; consentEpoch: number | undefined } {
    const [t, c] = cached.split(':');
    const consentEpoch = c === undefined || c === '' ? undefined : Number(c);
    return { tokenEpoch: Number(t), consentEpoch: Number.isFinite(consentEpoch) ? consentEpoch : undefined };
  }

  /**
   * Живость по УЖЕ РАСПАКОВАННОМУ payload — подпись проверил вызывающий
   * (на HTTP это делает passport-jwt до вызова strategy.validate).
   */
  async assertAlive(payload: JwtPayload): Promise<JwtPayload> {
    const key = authAliveKey(payload.sub);
    const tokenEpoch = payload.epoch ?? 0;
    // Семейство мягко завершено («Завершить сессию», «Это не я», забытое устройство): его
    // access-токены гаснут СРАЗУ, а не доживают свои 15 минут. Одним MGET с кэшем «жив».
    const famKey = payload.fam ? authFamilyRevokedKey(payload.fam) : null;
    try {
      const [cached, famRevoked] = famKey ? await this.redis.getClient().mget(key, famKey) : [await this.redis.get(key), null];
      if (famRevoked !== null && famRevoked !== undefined) throw unauthorized('auth.sessionExpired');
      if (cached !== null && cached !== undefined) {
        const parsed = this.parseCached(cached);
        if (parsed.tokenEpoch !== tokenEpoch) {
          throw unauthorized('auth.sessionExpired');
        }
        // Последняя активность семейства и устройства — не чаще раза в 5 минут (fire-and-forget)
        this.sessions.touch(payload.sub, payload.fam);
        // `cep` всегда переписывается сервером: значение из токена (если бы оно там оказалось) не доверяется
        return { ...payload, cep: parsed.consentEpoch };
      }
    } catch (err) {
      // ВАЖНО: отзыв не должен выглядеть как сбой Redis — пробрасываем как есть.
      if (err instanceof UnauthorizedException) throw err;
      /* Redis недоступен — проверяем в БД */
    }

    // Verify user still exists.
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, deletedAt: true, deletionScheduledAt: true, tokenEpoch: true, consentEpoch: true },
    });

    // Block both permanently-anonymized and grace-window (pending) accounts —
    // a pending account is "gone" until the user logs in again to restore it.
    if (!user || user.deletedAt || user.deletionScheduledAt) {
      throw unauthorized('auth.userNotFound');
    }

    try {
      await this.redis.set(key, `${user.tokenEpoch}:${user.consentEpoch}`, ALIVE_TTL_SECONDS);
    } catch {
      /* кэш — best-effort */
    }

    // Токен из прошлого поколения — отозван (смена пароля/номера, выход везде).
    if (user.tokenEpoch !== tokenEpoch) {
      throw unauthorized('auth.sessionExpired');
    }
    // Мимо кэша (промах или Redis недоступен) отзыв семейства проверяется по базе
    if (payload.fam) {
      const live = await this.db.session.findFirst({ where: { userId: payload.sub, familyId: payload.fam, revokedAt: null }, select: { id: true } });
      if (!live) throw unauthorized('auth.sessionExpired');
    }
    this.sessions.touch(payload.sub, payload.fam);

    return { ...payload, cep: user.consentEpoch };
  }

  /**
   * Подпись + срок, затем живость. Единый вход для HTTP (JwtAuthGuard) и рукопожатия
   * сокета. Подпись — EdDSA по `kid` из keystore (аудитория `product`); HS256 прошлой
   * эпохи принимается только на окне `KEYS_LEGACY_HS256_UNTIL`. Refresh-токен как
   * access не проходит: новый несёт `typ: refresh+jwt`, legacy — `jti`.
   */
  async verifyAccessToken(raw: string, opts: { enforceConsents?: boolean } = {}): Promise<JwtPayload> {
    let payload: JwtPayload & { jti?: string };
    try {
      payload = await this.signing.verify<JwtPayload>('product', raw, {
        // Строго access: любой будущий вид токена аудитории `product` сюда не пройдёт по умолчанию
        typ: 'at+jwt',
        forbidTyp: ['refresh+jwt'],
        legacy: { secret: legacySecret(), audienceOptional: true, typOptional: true },
      });
    } catch {
      throw unauthorized('auth.invalidToken');
    }
    if (!payload?.sub || payload.jti) throw unauthorized('auth.invalidToken');
    const alive = await this.assertAlive(payload);
    // Транспорт без маршрутов и декораторов (сокет): шлюз согласий применяется здесь же —
    // человек за блокирующим экраном не получает живую ленту событий в обход HTTP-гарда.
    if (opts.enforceConsents) await this.assertConsents(alive);
    return alive;
  }

  /** Шлюз согласий для транспортов без гарда: быстрый путь — сравнение эпох, иначе проверка по базе. */
  async assertConsents(payload: JwtPayload): Promise<void> {
    if (payload.kind === 'bot') return;
    const g = await this.consentsGate.globalEpoch();
    if (g === 0 || (typeof payload.cep === 'number' && payload.cep >= g)) return;
    if (await this.consentsGate.isUserBlocked(payload.sub)) {
      throw forbidden('consents.pending', undefined, { code: CONSENT_ERROR_CODES.pending });
    }
  }

  /**
   * Поколение ТОЛЬКО из кэша (null = ключа нет). Для дешёвой пере-проверки уже
   * открытого сокета: промах кэша отдаём как «не знаю», а не как отказ — платить
   * запросом в БД на каждый heartbeat каждого сокета мы не готовы.
   */
  async cachedEpoch(userId: string): Promise<number | null> {
    try {
      const cached = await this.redis.get(authAliveKey(userId));
      return cached === null ? null : this.parseCached(cached).tokenEpoch;
    } catch {
      return null;
    }
  }
}
