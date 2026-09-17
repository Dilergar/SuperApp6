import { Injectable, Logger } from '@nestjs/common';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, type KeyScopes } from '@superapp/shared';
import { DatabaseService } from '../../../shared/database/database.service';
import { forbidden, tooMany, unauthorized } from '../../../shared/errors/api-error';
import { RedisService } from '../../../shared/redis/redis.service';
import type { JwtPayload } from '../../../shared/decorators/current-user.decorator';
import { KeysMacService } from '../keys.mac.service';
import { hashApiSecret, parseApiSecret, roughPrefix } from './api-keys.format';
import { allowlistOf, ipAllowedBy, keyIsLive, scopesOf } from './api-keys.common';
import { KeysNotifier } from './keys.notifications';
import { MetricsService } from '../../../shared/metrics/metrics.service';
import type { Counter } from 'prom-client';

/** Снимок ключа в кэше (60 с): без секретов, всё нужное для решения «пускать ли». */
interface KeySnapshot {
  id: string;
  kind: 'bot' | 'pat';
  familyId: string;
  botId: string | null;
  /** Актор запроса: у бота — его теневой users.id, у личного ключа — человек */
  actorUserId: string;
  workspaceId: string | null;
  scopes: KeyScopes;
  ipAllowlist: string[];
  botAllowlist: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  graceUntil: string | null;
  botStatus: string | null;
  botRank: string | null;
  userGone: boolean;
  userKind: string;
  systemRole: string;
  phone: string;
  epoch: number;
  neverUsed: boolean;
}

/**
 * Аутентификация `Authorization: Bearer sa6_…`: формат + CRC → HMAC pepper-ключом →
 * строка (кэш 60 с в Redis) → отзыв/срок/grace → бот не заморожен → IP-allowlist →
 * `req.user`. Отказы считаются по связке IP + префикс (модель Discord): свыше
 * `authFailPerHour` — 429. Использование — в Redis (батч в БД раз в минуту).
 */
@Injectable()
export class ApiKeyAuthService {
  private readonly logger = new Logger(ApiKeyAuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly mac: KeysMacService,
    private readonly notifier: KeysNotifier,
    metrics: MetricsService,
  ) {
    this.authTotal = metrics.counter('keys_api_auth_total', 'API key authentications by result', ['result']);
  }

  /** Метрика исходов аутентификации ключом (`ok` | код отказа) — без id ключей */
  private readonly authTotal: Counter<string>;

  /**
   * @param country ISO-код страны из гео-заголовка CDN (нет CDN → null): «откуда»
   *   в реестре и в уведомлении о новом месте.
   */
  async authenticate(raw: string, ip: string | null, country: string | null = null): Promise<JwtPayload> {
    const failKey = KEYS_REDIS.authFail(ip ?? 'unknown', roughPrefix(raw));
    await this.assertNotBlocked(failKey);
    const parsed = parseApiSecret(raw);
    if (!parsed || parsed.kind === 'whs') throw await this.fail(failKey, 'invalid', unauthorized('keys.invalid', undefined, { code: KEYS_ERROR_CODES.invalid }));

    const snap = await this.load(raw);
    if (!snap) throw await this.fail(failKey, 'invalid', unauthorized('keys.invalid', undefined, { code: KEYS_ERROR_CODES.invalid }));
    const now = Date.now();
    if (snap.revokedAt) throw await this.fail(failKey, 'revoked', unauthorized('keys.revoked', undefined, { code: KEYS_ERROR_CODES.revoked }));
    if ((snap.graceUntil && Date.parse(snap.graceUntil) <= now) || (snap.expiresAt && Date.parse(snap.expiresAt) <= now)) {
      throw await this.fail(failKey, 'expired', unauthorized('keys.expired', undefined, { code: KEYS_ERROR_CODES.expired }));
    }
    if (snap.userGone) throw await this.fail(failKey, 'revoked', unauthorized('keys.revoked', undefined, { code: KEYS_ERROR_CODES.revoked }));
    if (snap.kind === 'bot') {
      if (snap.botStatus === 'frozen') throw await this.fail(failKey, 'frozen', forbidden('keys.bot.frozen', undefined, { code: KEYS_ERROR_CODES.botFrozen }));
      if (snap.botStatus !== 'active') throw await this.fail(failKey, 'archived', forbidden('keys.bot.archived', undefined, { code: KEYS_ERROR_CODES.botArchived }));
    }
    if (!ipAllowedBy(ip, snap.ipAllowlist, snap.botAllowlist)) {
      void this.notifier.newLocation(snap.id, snap.workspaceId, snap.actorUserId, snap.kind, ip).catch(() => undefined);
      throw await this.fail(failKey, 'ip_denied', forbidden('keys.ip.denied', undefined, { code: KEYS_ERROR_CODES.ipDenied }));
    }
    // Троттлер по ключу (не по IP): живой ключ, но слишком часто — 429 без счётчика отказов
    await this.assertRate(snap);
    this.authTotal.inc({ result: 'ok' });
    void this.touch(snap, ip, country).catch(() => undefined);
    return {
      sub: snap.actorUserId,
      phone: snap.phone,
      role: snap.systemRole,
      epoch: snap.epoch,
      kind: snap.kind === 'bot' ? 'bot' : 'user',
      keyId: snap.id,
      botId: snap.botId,
      keyWorkspaceId: snap.workspaceId,
      scopes: snap.scopes,
    };
  }

  /** Снимок по секрету: кэш → БД (хеш любой активной версией pepper — ротация без простоя). */
  private async load(raw: string): Promise<KeySnapshot | null> {
    const peppers = await this.mac.pepperVersions();
    if (!peppers.length) return null;
    const hashes = peppers.map((p) => hashApiSecret(p.material, raw));
    const cacheKey = KEYS_REDIS.apiKey(hashes[0]!);
    try {
      const cached = await this.redis.getJson<KeySnapshot>(cacheKey);
      if (cached) return cached;
    } catch {
      /* Redis недоступен — честный поход в БД */
    }
    const row = await this.db.apiKey.findFirst({
      where: { hash: { in: hashes } },
      include: { bot: { select: { status: true, rank: true, userId: true, ipAllowlist: true, workspaceId: true } } },
    });
    if (!row) return null;
    const actorUserId = row.kind === 'bot' ? row.bot?.userId ?? null : row.userId;
    if (!actorUserId) return null;
    const user = await this.db.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, deletedAt: true, deletionScheduledAt: true, kind: true, phone: true, tokenEpoch: true, roles: { where: { context: 'system', isActive: true }, select: { role: true } } },
    });
    const roles = user?.roles.map((r) => r.role) ?? [];
    const snap: KeySnapshot = {
      id: row.id,
      kind: row.kind as 'bot' | 'pat',
      familyId: row.familyId,
      botId: row.botId,
      actorUserId,
      workspaceId: row.kind === 'bot' ? row.bot?.workspaceId ?? row.workspaceId : row.workspaceId,
      scopes: scopesOf(row.scopes, row.kind === 'bot'),
      ipAllowlist: allowlistOf(row.ipAllowlist),
      botAllowlist: allowlistOf(row.bot?.ipAllowlist),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      graceUntil: row.graceUntil?.toISOString() ?? null,
      botStatus: row.bot?.status ?? null,
      botRank: row.bot?.rank ?? null,
      userGone: !user || !!user.deletedAt || !!user.deletionScheduledAt,
      userKind: user?.kind ?? 'person',
      systemRole: roles.includes('admin') ? 'admin' : roles.includes('moderator') ? 'moderator' : 'user',
      phone: row.kind === 'bot' ? '' : user?.phone ?? '',
      epoch: user?.tokenEpoch ?? 0,
      neverUsed: !row.lastUsedAt,
    };
    // Мёртвый ключ не кэшируем (redкий путь; отзыв должен читаться из БД)
    if (keyIsLive(row) && snap.botStatus !== 'frozen') {
      try {
        await this.redis.setJson(cacheKey, snap, KEYS_LIMITS.keyCacheSec);
      } catch {
        /* best-effort */
      }
    }
    return snap;
  }

  /** Сброс кэша ключа (отзыв, ротация, заморозка бота) — по хешу строки. */
  async invalidateByHash(hash: string): Promise<void> {
    await this.redis.del(KEYS_REDIS.apiKey(hash)).catch(() => undefined);
  }

  private async assertNotBlocked(failKey: string): Promise<void> {
    try {
      const n = Number((await this.redis.get(failKey)) ?? 0);
      if (n >= KEYS_LIMITS.authFailPerHour) throw tooMany('keys.invalid', undefined, { code: KEYS_ERROR_CODES.invalid, resendInSec: 3600 });
    } catch (err) {
      if ((err as { status?: number }).status === 429) throw err;
    }
  }

  /**
   * Потолок обращений ключа в минуту — корзина минуты в Redis (`keys:rate:<id>:<minute>`).
   * Redis недоступен → лимит не считается (аутентификация и так уже прошла по БД).
   * Первое превышение за сутки — уведомление `key.throttled` держателю (аномалия объёма).
   */
  private async assertRate(snap: KeySnapshot): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = KEYS_REDIS.rate(snap.id, minute);
    let n = 0;
    try {
      const client = this.redis.getClient();
      n = await client.incr(key);
      if (n === 1) await client.expire(key, 120);
    } catch {
      return;
    }
    if (n <= KEYS_LIMITS.requestsPerMinute) return;
    if (n === KEYS_LIMITS.requestsPerMinute + 1) void this.notifier.throttled(snap.id, 'rate').catch(() => undefined);
    this.authTotal.inc({ result: 'rate_limited' });
    throw tooMany('keys.rate_limited', undefined, { code: KEYS_ERROR_CODES.rateLimited, resendInSec: 60 - (Math.floor(Date.now() / 1000) % 60) });
  }

  private async fail<T>(failKey: string, result: string, error: T): Promise<T> {
    this.authTotal.inc({ result });
    try {
      const client = this.redis.getClient();
      const n = await client.incr(failKey);
      if (n === 1) await client.expire(failKey, 3600);
    } catch {
      /* best-effort */
    }
    return error;
  }

  /** Использование — в Redis: hash `keys:last-used` (id → {at, ip, n}); крон сливает в БД раз в минуту. */
  private async touch(snap: KeySnapshot, ip: string | null, country: string | null): Promise<void> {
    const client = this.redis.getClient();
    const field = snap.id;
    const prev = await client.hget(KEYS_REDIS.lastUsed, field);
    const n = prev ? (JSON.parse(prev) as { n?: number }).n ?? 0 : 0;
    await client.hset(KEYS_REDIS.lastUsed, field, JSON.stringify({ at: new Date().toISOString(), ip, country, n: n + 1, first: snap.neverUsed && n === 0 }));
  }
}
