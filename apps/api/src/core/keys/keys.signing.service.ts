import { Injectable, Logger } from '@nestjs/common';
import { KEYS_LIMITS, SIGNING_AUDIENCES, type JwksDto, type SigningAudience } from '@superapp/shared';
import { JobsService } from '../jobs/jobs.service';
import { KEYS_JOBS, PLATFORM_SCOPE } from './keys.constants';
import { keysEnv, legacyHs256Open } from './keys.env';
import { b64url, bufEqual, ed25519RawPublic, encodeJws, hs256, nowSec, parseJws, type JwsHeader, type JwtStdClaims } from './keys.jwt';
import { KeysStoreService, type LoadedVersion } from './keys.store.service';

export type KeysTokenReason = 'format' | 'alg' | 'kid' | 'signature' | 'expired' | 'not_yet' | 'audience' | 'typ' | 'legacy_closed';

export class KeysTokenError extends Error {
  constructor(readonly reason: KeysTokenReason) {
    super(`token rejected: ${reason}`);
    this.name = 'KeysTokenError';
  }
}

export interface SignOptions {
  /** Срок жизни, секунд */
  ttlSec: number;
  /** `typ` заголовка: `at+jwt` у access, `refresh+jwt` у refresh и т.д. */
  typ?: string;
  /** Не ставить `iat`/`exp` (нужно только тестам) */
  raw?: boolean;
}

export interface VerifyOptions {
  /** Требовать `typ` заголовка */
  typ?: string;
  /** Отвергать эти `typ` (refresh-токен, предъявленный как access) */
  forbidTyp?: string[];
  /** Legacy HS256 на окне миграции: секрет вызывающего (продукт — JWT_SECRET_LEGACY; кабинет — свой) */
  legacy?: { secret: string | null; audienceOptional?: boolean };
  /** Допуск часов, секунд */
  clockToleranceSec?: number;
}

/**
 * Подпись JWT движка: `alg: EdDSA` (Ed25519), `kid` версии, `aud` обязателен, отдельная
 * пара на каждую аудиторию. Верификатор — allow-list `['EdDSA']` (+ `HS256` только на
 * окне `KEYS_LEGACY_HS256_UNTIL`), ключ ТОЛЬКО из keystore по `kid` (никаких `jku`/`jwk`).
 * Ротация: новая версия `pending` → в JWKS → через ≥ TTL кэша `active` (primary), старая
 * остаётся `active` для проверки до окна максимального срока токена → уничтожение.
 */
@Injectable()
export class KeysSigningService {
  private readonly logger = new Logger(KeysSigningService.name);
  private jwksCache: { at: number; value: JwksDto } | null = null;
  private lastUnknownKidRefetch = 0;

  constructor(
    private readonly store: KeysStoreService,
    private readonly jobs: JobsService,
  ) {}

  async ensureAll(): Promise<void> {
    for (const aud of SIGNING_AUDIENCES) await this.store.ensureKey(PLATFORM_SCOPE, 'sign', aud);
  }

  private async primary(audience: SigningAudience): Promise<LoadedVersion> {
    await this.store.ensureKey(PLATFORM_SCOPE, 'sign', audience);
    return this.store.primary(PLATFORM_SCOPE, 'sign', audience);
  }

  async sign(audience: SigningAudience, claims: Record<string, unknown>, opts: SignOptions): Promise<string> {
    const v = await this.primary(audience);
    const header: JwsHeader = { alg: 'EdDSA', kid: v.kid, ...(opts.typ ? { typ: opts.typ } : {}) };
    const now = nowSec();
    const payload: Record<string, unknown> = opts.raw ? { ...claims, aud: audience } : { ...claims, aud: audience, iat: now, exp: now + opts.ttlSec };
    const input = encodeJws(header, payload);
    const sig = await this.store.provider.sign(v.material!, Buffer.from(input, 'utf8'));
    return `${input}.${b64url(sig)}`;
  }

  /**
   * Проверка подписи и стандартных клеймов. Бросает `KeysTokenError` (причина — только
   * для лога; наружу уходит общий `auth.invalidToken`).
   */
  async verify<T extends object>(audience: SigningAudience, token: string, opts: VerifyOptions = {}): Promise<T & JwtStdClaims> {
    const parsed = parseJws(token);
    if (!parsed) throw new KeysTokenError('format');
    const { header, payload, signature, signingInput } = parsed;
    const tolerance = opts.clockToleranceSec ?? 5;
    const now = nowSec();

    if (header.alg === 'EdDSA') {
      if (!header.kid) throw new KeysTokenError('kid');
      let v = await this.store.version(header.kid);
      // Неизвестный kid: соседний инстанс мог только что ротировать ключ — один re-fetch с лимитом
      if (!v && Date.now() - this.lastUnknownKidRefetch > KEYS_LIMITS.unknownKidRefetchSec * 1000) {
        this.lastUnknownKidRefetch = Date.now();
        await this.store.bumpEpochLocalOnly();
        v = await this.store.version(header.kid);
      }
      if (!v || v.scope !== PLATFORM_SCOPE || v.purpose !== 'sign' || v.name !== audience || !v.publicKey) throw new KeysTokenError('kid');
      if (v.state !== 'active') throw new KeysTokenError('kid');
      const ok = await this.store.provider.verify(v.publicKey, Buffer.from(signingInput, 'utf8'), signature);
      if (!ok) throw new KeysTokenError('signature');
      if (!this.audienceMatches(payload.aud, audience)) throw new KeysTokenError('audience');
    } else {
      // HS256 — только legacy-окно и только с секретом вызывающего
      const secret = opts.legacy?.secret ?? null;
      if (!secret || !legacyHs256Open()) throw new KeysTokenError('legacy_closed');
      if (!bufEqual(hs256(secret, signingInput), signature)) throw new KeysTokenError('signature');
      // Legacy-токены продукта не несли aud; кабинет нёс `platform` — при наличии обязан совпасть
      if (payload.aud !== undefined && !this.audienceMatches(payload.aud, audience)) throw new KeysTokenError('audience');
      if (payload.aud === undefined && !opts.legacy?.audienceOptional) throw new KeysTokenError('audience');
    }

    if (opts.typ && header.typ !== opts.typ) throw new KeysTokenError('typ');
    if (opts.forbidTyp && header.typ && opts.forbidTyp.includes(header.typ)) throw new KeysTokenError('typ');
    if (typeof payload.exp !== 'number' || payload.exp + tolerance <= now) throw new KeysTokenError('expired');
    if (typeof payload.nbf === 'number' && payload.nbf - tolerance > now) throw new KeysTokenError('not_yet');
    return payload as unknown as T & JwtStdClaims;
  }

  private audienceMatches(aud: unknown, expected: string): boolean {
    if (typeof aud === 'string') return aud === expected;
    if (Array.isArray(aud)) return aud.includes(expected);
    return false;
  }

  /**
   * Подпись СЫРОЙ строки (не JWT) — для подписанных ссылок файлов и Ed25519-подписи
   * вебхуков: `{kid, sig}` base64url. Проверка — `verifyRaw` версией из `kid`.
   */
  async signRaw(audience: SigningAudience, data: string): Promise<{ kid: string; sig: string }> {
    const v = await this.primary(audience);
    const sig = await this.store.provider.sign(v.material!, Buffer.from(data, 'utf8'));
    return { kid: v.kid, sig: b64url(sig) };
  }

  async verifyRaw(audience: SigningAudience, kid: string, data: string, sig: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !/^[A-Za-z0-9_-]{60,120}$/.test(sig)) return false;
    const v = await this.store.version(kid);
    if (!v || v.scope !== PLATFORM_SCOPE || v.purpose !== 'sign' || v.name !== audience || v.state !== 'active' || !v.publicKey) return false;
    return this.store.provider.verify(v.publicKey, Buffer.from(data, 'utf8'), Buffer.from(sig, 'base64url'));
  }

  /** Публичный ключ primary-версии аудитории (для получателей вебхуков с Ed25519). */
  async publicKeyOf(audience: SigningAudience): Promise<{ kid: string; publicKey: string }> {
    const v = await this.primary(audience);
    return { kid: v.kid, publicKey: ed25519RawPublic(v.publicKey!).toString('base64url') };
  }

  /** Все активные и pending версии всех аудиторий (кэш 10 мин; сброс — эпохой store). */
  async jwks(): Promise<JwksDto> {
    const epoch = await this.store.epoch();
    if (this.jwksCache && this.jwksCache.at === epoch) return this.jwksCache.value;
    const keys: JwksDto['keys'] = [];
    for (const aud of SIGNING_AUDIENCES) {
      const key = await this.store.getKey(PLATFORM_SCOPE, 'sign', aud);
      if (!key) continue;
      for (const v of key.versions) {
        if ((v.state !== 'active' && v.state !== 'pending') || !v.publicKey) continue;
        keys.push({ kty: 'OKP', crv: 'Ed25519', kid: v.kid, x: ed25519RawPublic(v.publicKey).toString('base64url'), use: 'sig', alg: 'EdDSA' });
      }
    }
    const value = { keys };
    this.jwksCache = { at: epoch, value };
    return value;
  }

  /**
   * Ротация аудитории: новая версия `pending` (уже в JWKS) → джоб активации через
   * `signingActivateDelayMin` → старая остаётся `active` до окна `retireAfterSec`
   * (максимальный срок токена аудитории + кэш) → `destroy_scheduled`.
   */
  async rotate(audience: SigningAudience, opts: { actorId?: string | null; reason?: string | null; activateInMin?: number; retireAfterSec: number }): Promise<{ kid: string }> {
    const key = await this.store.ensureKey(PLATFORM_SCOPE, 'sign', audience);
    const previousKid = key.primaryKid;
    const kid = await this.store.createVersion(key.id, 'pending', { actorId: opts.actorId ?? null, actorKind: opts.actorId ? 'platform' : 'system', reason: opts.reason ?? null });
    const delayMs = (opts.activateInMin ?? KEYS_LIMITS.signingActivateDelayMin) * 60_000;
    await this.jobs.enqueue(null, {
      type: KEYS_JOBS.signingActivate,
      payload: { kid, previousKid, retireAfterSec: opts.retireAfterSec },
      runAt: new Date(Date.now() + delayMs),
      uniqueKey: `activate:${kid}`,
    });
    return { kid };
  }

  status(): { legacyHs256Until: string | null; legacyOpen: boolean } {
    const env = keysEnv();
    return { legacyHs256Until: env.legacyHs256Until?.toISOString() ?? null, legacyOpen: legacyHs256Open(env) };
  }
}
