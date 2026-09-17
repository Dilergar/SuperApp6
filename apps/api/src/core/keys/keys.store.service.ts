import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type CryptoKey, type CryptoKeyVersion } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, KEY_ALGORITHMS, type KeyPurpose, type KeyVersionState } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { MetricsService } from '../../shared/metrics/metrics.service';
import type { Counter } from 'prom-client';
import { forbidden } from '../../shared/errors/api-error';
import { KeysAuditService } from './keys.audit.service';
import { KEY_AUDIT_ACTIONS } from './keys.constants';
import { KEY_PROVIDER, type KeyProvider } from './providers/key-provider';

type Tx = Prisma.TransactionClient;

/** Версия с распакованным материалом (только в памяти процесса, TTL `kekCacheSec`). */
export interface LoadedVersion {
  kid: string;
  keyId: string;
  scope: string;
  purpose: KeyPurpose;
  name: string;
  algorithm: string;
  version: number;
  state: KeyVersionState;
  material: Buffer | null;
  publicKey: Buffer | null;
  rootKid: string;
  createdAt: Date;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  destroyScheduledAt: Date | null;
  destroyedAt: Date | null;
}

export interface LoadedKey {
  id: string;
  scope: string;
  purpose: KeyPurpose;
  name: string;
  algorithm: string;
  provider: string;
  primaryKid: string | null;
  createdAt: Date;
  /** Без материала */
  versions: Omit<LoadedVersion, 'material'>[];
}

const CACHE_MS = KEYS_LIMITS.kekCacheSec * 1000;

/** Prisma `Bytes` — `Uint8Array` поверх ArrayBuffer; Buffer из node:crypto сюда не подходит по типу. */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => Uint8Array.from(b);

/**
 * Keystore: `CryptoKey` (scope × purpose × name) → версии с материалом, обёрнутым
 * корнем провайдера. Все чтения материала кэшируются в памяти на 5 минут и
 * сбрасываются эпохой `keys:epoch` в Redis (ротация, заморозка — любой инстанс
 * узнаёт за ≤ 1 с). Семантика состояний: `active` — используется (primary — для
 * записи/подписи, остальные — для чтения/проверки), `pending` — опубликована в JWKS,
 * `disabled` — НЕ используется ни для чего (kill-switch организации), `destroyed` —
 * материала нет. Права здесь не проверяются — это system-слой движка.
 */
@Injectable()
export class KeysStoreService {
  private readonly logger = new Logger(KeysStoreService.name);
  private epochLocal = 0;
  private epochAt = 0;
  /** Метрики (shared/metrics): распаковки корнем и попадания кэша версий — без id ключей в метках */
  private readonly unwrapTotal: Counter<string>;
  private readonly cacheHit: Counter<string>;
  private readonly keyCache = new Map<string, { at: number; epoch: number; key: LoadedKey }>();
  private readonly versionCache = new Map<string, { at: number; epoch: number; v: LoadedVersion }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: KeysAuditService,
    @Inject(KEY_PROVIDER) readonly provider: KeyProvider,
    private readonly metrics: MetricsService,
  ) {
    this.unwrapTotal = this.metrics.counter('keys_unwrap_total', 'Key versions unwrapped by the root provider', ['purpose']);
    this.cacheHit = this.metrics.counter('keys_cache_hit_total', 'Key version cache lookups by result', ['result']);
  }

  // ------------------------------------------------------------
  // Эпоха и кэш
  // ------------------------------------------------------------

  /** Эпоха keystore (микро-кэш `epochCacheMs`); Redis недоступен → последняя известная. */
  async epoch(): Promise<number> {
    const now = Date.now();
    if (now - this.epochAt < KEYS_LIMITS.epochCacheMs) return this.epochLocal;
    try {
      const raw = await this.redis.get(KEYS_REDIS.epoch);
      const next = raw ? Number(raw) : 0;
      if (next !== this.epochLocal) {
        this.keyCache.clear();
        this.versionCache.clear();
        this.epochLocal = next;
      }
      this.epochAt = now;
    } catch {
      /* Redis недоступен — живём на локальной эпохе (кэш протухнет по TTL) */
    }
    return this.epochLocal;
  }

  /** После любой мутации keystore: соседние инстансы сбросят кэш за ≤ 1 с. */
  async bumpEpoch(): Promise<void> {
    this.keyCache.clear();
    this.versionCache.clear();
    this.epochAt = 0;
    try {
      await this.redis.getClient().incr(KEYS_REDIS.epoch);
    } catch (err) {
      this.logger.warn(`keys epoch bump failed (caches expire by TTL): ${(err as Error).message}`);
    }
  }

  /** Сбросить ТОЛЬКО локальные кэши (неизвестный `kid` от соседа): перечитать без INCR эпохи. */
  async bumpEpochLocalOnly(): Promise<void> {
    this.keyCache.clear();
    this.versionCache.clear();
    this.epochAt = 0;
    await this.epoch();
  }

  private cacheKey(scope: string, purpose: KeyPurpose, name: string): string {
    return `${scope}|${purpose}|${name}`;
  }

  // ------------------------------------------------------------
  // Чтение
  // ------------------------------------------------------------

  private toLoadedKey(row: CryptoKey & { versions: CryptoKeyVersion[] }): LoadedKey {
    return {
      id: row.id,
      scope: row.scope,
      purpose: row.purpose as KeyPurpose,
      name: row.name,
      algorithm: row.algorithm,
      provider: row.provider,
      primaryKid: row.primaryVersionId,
      createdAt: row.createdAt,
      versions: row.versions
        .sort((a, b) => a.version - b.version)
        .map((v) => ({
          kid: v.id,
          keyId: v.keyId,
          scope: row.scope,
          purpose: row.purpose as KeyPurpose,
          name: row.name,
          algorithm: row.algorithm,
          version: v.version,
          state: v.state as KeyVersionState,
          publicKey: v.publicKey ? Buffer.from(v.publicKey) : null,
          rootKid: v.rootKid,
          createdAt: v.createdAt,
          activatedAt: v.activatedAt,
          deactivatedAt: v.deactivatedAt,
          destroyScheduledAt: v.destroyScheduledAt,
          destroyedAt: v.destroyedAt,
        })),
    };
  }

  async getKey(scope: string, purpose: KeyPurpose, name: string, client: Tx | DatabaseService = this.db): Promise<LoadedKey | null> {
    const epoch = await this.epoch();
    const ck = this.cacheKey(scope, purpose, name);
    const hit = this.keyCache.get(ck);
    if (hit && hit.epoch === epoch && Date.now() - hit.at < CACHE_MS) return hit.key;
    const row = await client.cryptoKey.findUnique({ where: { scope_purpose_name: { scope, purpose, name } }, include: { versions: true } });
    if (!row) return null;
    const key = this.toLoadedKey(row);
    this.keyCache.set(ck, { at: Date.now(), epoch, key });
    return key;
  }

  /** Версия с распакованным материалом; `null` — нет такой. Уничтоженная — без материала. */
  async version(kid: string): Promise<LoadedVersion | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) return null;
    const epoch = await this.epoch();
    const hit = this.versionCache.get(kid);
    if (hit && hit.epoch === epoch && Date.now() - hit.at < CACHE_MS) {
      this.cacheHit.inc({ result: 'hit' });
      return hit.v;
    }
    this.cacheHit.inc({ result: 'miss' });
    const row = await this.db.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
    if (!row) return null;
    const purpose = row.key.purpose as KeyPurpose;
    let material: Buffer | null = null;
    if (row.wrappedMaterial && row.state !== 'destroyed') {
      material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial), this.wrapAad(row.id, purpose));
      this.unwrapTotal.inc({ purpose });
    }
    const v: LoadedVersion = {
      kid: row.id,
      keyId: row.keyId,
      scope: row.key.scope,
      purpose,
      name: row.key.name,
      algorithm: row.key.algorithm,
      version: row.version,
      state: row.state as KeyVersionState,
      material,
      publicKey: row.publicKey ? Buffer.from(row.publicKey) : null,
      rootKid: row.rootKid,
      createdAt: row.createdAt,
      activatedAt: row.activatedAt,
      deactivatedAt: row.deactivatedAt,
      destroyScheduledAt: row.destroyScheduledAt,
      destroyedAt: row.destroyedAt,
    };
    this.versionCache.set(kid, { at: Date.now(), epoch, v });
    return v;
  }

  /** Прогреть кэш версий одной выборкой (расшифровка списка со многими KEK: ростер, окружение). */
  async prefetch(kids: string[]): Promise<void> {
    const epoch = await this.epoch();
    const now = Date.now();
    const missing = kids.filter((kid) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) return false;
      const hit = this.versionCache.get(kid);
      return !(hit && hit.epoch === epoch && now - hit.at < CACHE_MS);
    });
    if (!missing.length) return;
    const rows = await this.db.cryptoKeyVersion.findMany({ where: { id: { in: missing } }, include: { key: true } });
    for (const row of rows) {
      const purpose = row.key.purpose as KeyPurpose;
      let material: Buffer | null = null;
      if (row.wrappedMaterial && row.state !== 'destroyed') {
        try {
          material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial), this.wrapAad(row.id, purpose));
          this.unwrapTotal.inc({ purpose });
        } catch (err) {
          this.logger.warn(`prefetch ${row.id}: ${(err as Error).message}`);
          continue;
        }
      }
      this.versionCache.set(row.id, {
        at: now,
        epoch,
        v: {
          kid: row.id,
          keyId: row.keyId,
          scope: row.key.scope,
          purpose,
          name: row.key.name,
          algorithm: row.key.algorithm,
          version: row.version,
          state: row.state as KeyVersionState,
          material,
          publicKey: row.publicKey ? Buffer.from(row.publicKey) : null,
          rootKid: row.rootKid,
          createdAt: row.createdAt,
          activatedAt: row.activatedAt,
          deactivatedAt: row.deactivatedAt,
          destroyScheduledAt: row.destroyScheduledAt,
          destroyedAt: row.destroyedAt,
        },
      });
    }
  }

  /** Primary-версия ключа (для записи/подписи). Ключа нет или он заморожен → 403 `keys.key_unavailable`. */
  async primary(scope: string, purpose: KeyPurpose, name: string): Promise<LoadedVersion> {
    const key = await this.getKey(scope, purpose, name);
    if (!key?.primaryKid) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    const v = await this.version(key.primaryKid);
    if (!v || v.state !== 'active' || !v.material) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    return v;
  }

  /** Версия, годная для чтения/проверки (`active` любой, `pending` — только подпись для JWKS). */
  async usable(kid: string, opts: { allowPending?: boolean } = {}): Promise<LoadedVersion> {
    const v = await this.version(kid);
    if (!v || !v.material) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    if (v.state === 'active' || (opts.allowPending && v.state === 'pending')) return v;
    throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
  }

  /** Все живые версии ключа с материалом (проверка HMAC/подписи любой активной версией). */
  async activeVersions(scope: string, purpose: KeyPurpose, name: string): Promise<LoadedVersion[]> {
    const key = await this.getKey(scope, purpose, name);
    if (!key) return [];
    const out: LoadedVersion[] = [];
    for (const meta of key.versions) {
      if (meta.state !== 'active') continue;
      const v = await this.version(meta.kid);
      if (v?.material) out.push(v);
    }
    return out;
  }

  // ------------------------------------------------------------
  // Создание
  // ------------------------------------------------------------

  private wrapAad(kid: string, purpose: KeyPurpose): string {
    return `${kid}|${purpose}`;
  }

  private algorithmOf(purpose: KeyPurpose): string {
    return KEY_ALGORITHMS[purpose];
  }

  /**
   * Ключ есть (и у него есть primary active-версия) — идемпотентно и без гонок:
   * INSERT … ON CONFLICT DO NOTHING + advisory-лок на создание первой версии.
   */
  async ensureKey(scope: string, purpose: KeyPurpose, name: string): Promise<LoadedKey> {
    const existing = await this.getKey(scope, purpose, name);
    if (existing?.primaryKid) return existing;
    const created = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`keys:ensure:${scope}:${purpose}:${name}`}))`;
      let row = await tx.cryptoKey.findUnique({ where: { scope_purpose_name: { scope, purpose, name } }, include: { versions: true } });
      if (!row) {
        await tx.cryptoKey.createMany({
          data: { scope, purpose, name, algorithm: this.algorithmOf(purpose), provider: this.provider.kind },
          skipDuplicates: true,
        });
        row = await tx.cryptoKey.findUniqueOrThrow({ where: { scope_purpose_name: { scope, purpose, name } }, include: { versions: true } });
        await this.audit.log(tx, {
          actorKind: 'system',
          workspaceId: scope.startsWith('workspace:') ? scope.slice('workspace:'.length) : null,
          subjectType: 'crypto_key',
          subjectId: row.id,
          subjectName: `${scope}/${purpose}/${name}`,
          action: KEY_AUDIT_ACTIONS.keyCreated,
        });
      }
      if (!row.primaryVersionId) {
        await this.createVersionTx(tx, row, 'active');
      }
      return row.id;
    });
    await this.bumpEpoch();
    const key = await this.getKey(scope, purpose, name);
    if (!key) throw new Error(`keystore: key ${created} vanished right after creation`);
    return key;
  }

  /** Новая версия (материал — от провайдера). `active` — сразу становится primary, прежняя остаётся active (читает). */
  private async createVersionTx(tx: Tx, key: CryptoKey, state: 'pending' | 'active'): Promise<string> {
    const purpose = key.purpose as KeyPurpose;
    const kid = randomUUID();
    let material: Buffer;
    let publicKey: Buffer | null = null;
    if (purpose === 'sign') {
      const pair = await this.provider.generateSigningPair();
      material = pair.privateKey;
      publicKey = pair.publicKey;
    } else {
      material = await this.provider.generateSymmetric();
    }
    const wrapped = await this.provider.wrap(material, this.wrapAad(kid, purpose));
    const last = await tx.cryptoKeyVersion.aggregate({ where: { keyId: key.id }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const now = new Date();
    await tx.cryptoKeyVersion.create({
      data: {
        id: kid,
        keyId: key.id,
        version,
        state,
        wrappedMaterial: bytes(wrapped),
        publicKey: publicKey ? bytes(publicKey) : null,
        rootKid: this.provider.rootKid,
        activatedAt: state === 'active' ? now : null,
      },
    });
    if (state === 'active') await tx.cryptoKey.update({ where: { id: key.id }, data: { primaryVersionId: kid } });
    await this.audit.log(tx, {
      actorKind: 'system',
      workspaceId: key.scope.startsWith('workspace:') ? key.scope.slice('workspace:'.length) : null,
      subjectType: 'key_version',
      subjectId: kid,
      subjectName: `${key.scope}/${key.purpose}/${key.name} v${version}`,
      action: KEY_AUDIT_ACTIONS.versionCreated,
      details: { state, rootKid: this.provider.rootKid },
    });
    return kid;
  }

  /** Публичная ротация: новая версия (`pending` для подписи — активируется джобом, `active` для KEK/MAC). */
  async createVersion(keyId: string, state: 'pending' | 'active', actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}): Promise<string> {
    const kid = await this.db.$transaction(async (tx) => {
      const key = await tx.cryptoKey.findUniqueOrThrow({ where: { id: keyId } });
      const id = await this.createVersionTx(tx, key, state);
      if (actor.actorId || actor.reason) {
        await this.audit.log(tx, {
          actorId: actor.actorId ?? null,
          actorKind: actor.actorKind ?? 'user',
          workspaceId: key.scope.startsWith('workspace:') ? key.scope.slice('workspace:'.length) : null,
          subjectType: 'crypto_key',
          subjectId: key.id,
          subjectName: `${key.scope}/${key.purpose}/${key.name}`,
          action: KEY_AUDIT_ACTIONS.versionCreated,
          reason: actor.reason ?? null,
          details: { kid: id, state },
        });
      }
      return id;
    });
    await this.bumpEpoch();
    return kid;
  }

  // ------------------------------------------------------------
  // Переходы состояний (status-guarded updateMany — гонка двух активаций невозможна)
  // ------------------------------------------------------------

  /** `pending` → `active` и primary; прежняя primary остаётся `active` (только проверяет/читает). */
  async activate(kid: string): Promise<boolean> {
    const ok = await this.db.$transaction(async (tx) => {
      const v = await tx.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      const { count } = await tx.cryptoKeyVersion.updateMany({ where: { id: kid, state: 'pending' }, data: { state: 'active', activatedAt: new Date() } });
      if (count === 0) return false;
      await tx.cryptoKey.update({ where: { id: v.keyId }, data: { primaryVersionId: kid } });
      await this.audit.log(tx, { actorKind: 'system', subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionActivated });
      return true;
    });
    if (ok) await this.bumpEpoch();
    return ok;
  }

  /** `active` → `disabled`: версия перестаёт работать (у primary — ключ становится недоступен целиком). */
  async disable(kid: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['active', 'pending'] } }, data: { state: 'disabled', deactivatedAt: new Date() } });
      if (count === 0) return false;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionDisabled, reason: actor.reason ?? null });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpEpoch();
    return ok;
  }

  /** `disabled` | `destroy_scheduled` → `active` (восстановление; primary-указатель ключа не менялся). */
  async enable(kid: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['disabled', 'destroy_scheduled'] } }, data: { state: 'active', deactivatedAt: null, destroyScheduledAt: null } });
      if (count === 0) return false;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionEnabled, reason: actor.reason ?? null });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpEpoch();
    return ok;
  }

  /** Назначить уничтожение (после `destroyDelayDays`); восстановимо через `enable`. Уже primary нельзя. */
  async scheduleDestroy(kid: string, at: Date, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['active', 'disabled', 'pending'] } }, data: { state: 'destroy_scheduled', destroyScheduledAt: at, deactivatedAt: v.deactivatedAt ?? new Date() } });
      if (count === 0) return false;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionDestroyScheduled, reason: actor.reason ?? null, details: { at: at.toISOString() } });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpEpoch();
    return ok;
  }

  /** Уничтожить материал (crypto-shredding). Только из `destroy_scheduled` и только по сроку. */
  async destroyDue(now = new Date()): Promise<number> {
    const due = await this.db.cryptoKeyVersion.findMany({ where: { state: 'destroy_scheduled', destroyScheduledAt: { lte: now } }, include: { key: true }, take: 200 });
    let n = 0;
    for (const v of due) {
      const ok = await this.db.$transaction(async (tx) => {
        const { count } = await tx.cryptoKeyVersion.updateMany({ where: { id: v.id, state: 'destroy_scheduled' }, data: { state: 'destroyed', wrappedMaterial: null, destroyedAt: now } });
        if (count === 0) return false;
        await this.audit.log(tx, { actorKind: 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: v.id, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionDestroyed });
        return true;
      });
      if (ok) n++;
    }
    if (n) await this.bumpEpoch();
    return n;
  }

  // ------------------------------------------------------------
  // Скоуп целиком (организация / человек): заморозка и шреддинг
  // ------------------------------------------------------------

  /** Kill-switch: все версии скоупа → `disabled` — данные субъекта нечитаемы мгновенно. */
  async freezeScope(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { keyId: { in: keys.map((k) => k.id) }, state: { in: ['active', 'pending'] } }, data: { state: 'disabled', deactivatedAt: new Date() } });
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'platform', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.scopeFrozen, reason: actor.reason ?? null, details: { versions: count } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpEpoch();
    return n;
  }

  async unfreezeScope(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { keyId: { in: keys.map((k) => k.id) }, state: 'disabled' }, data: { state: 'active', deactivatedAt: null } });
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'platform', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.scopeUnfrozen, reason: actor.reason ?? null, details: { versions: count } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpEpoch();
    return n;
  }

  /** Шреддинг субъекта: все версии скоупа → `destroy_scheduled` через `destroyDelayDays` (восстановимо до срока). */
  async scheduleScopeDestroy(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const at = new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000);
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { keyId: { in: keys.map((k) => k.id) }, state: { in: ['active', 'pending', 'disabled'] } }, data: { state: 'destroy_scheduled', destroyScheduledAt: at, deactivatedAt: new Date() } });
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.versionDestroyScheduled, reason: actor.reason ?? null, details: { versions: count, at: at.toISOString() } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpEpoch();
    return n;
  }

  /** Все ключи скоупа (панель кабинета, дев-полигон). */
  async listScope(scope: string): Promise<LoadedKey[]> {
    const rows = await this.db.cryptoKey.findMany({ where: { scope }, include: { versions: true }, orderBy: [{ purpose: 'asc' }, { name: 'asc' }] });
    return rows.map((r) => this.toLoadedKey(r));
  }

  async countKeks(): Promise<number> {
    return this.db.cryptoKey.count({ where: { purpose: 'kek' } });
  }

  /** Версии, обёрнутые другим корнем (смоук бута: файл не тот — отказ, а не тихие ошибки на первом запросе). */
  async versionsWithForeignRoot(): Promise<number> {
    return this.db.cryptoKeyVersion.count({ where: { state: { not: 'destroyed' }, rootKid: { not: this.provider.rootKid } } });
  }

  /**
   * Ротация корня: перешить материал ВСЕХ живых версий с текущего корня на новый.
   * В одной транзакции; после коммита каждый инстанс обязан быть перезапущен с новым
   * файлом (иначе его unwrap получит `root_mismatch`). `dryRun` — только подсчёт.
   */
  async rewrapAllToProvider(next: KeyProvider, actor: { actorId: string | null; reason: string | null }, tx: Tx, dryRun: boolean): Promise<{ versions: number; fromRootKid: string; toRootKid: string }> {
    const rows = await tx.cryptoKeyVersion.findMany({ where: { state: { not: 'destroyed' }, wrappedMaterial: { not: null } }, include: { key: true } });
    if (!dryRun) {
      for (const row of rows) {
        const purpose = row.key.purpose as KeyPurpose;
        const aad = this.wrapAad(row.id, purpose);
        const material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial!), aad);
        const wrapped = await next.wrap(material, aad);
        await tx.cryptoKeyVersion.update({ where: { id: row.id }, data: { wrappedMaterial: bytes(wrapped), rootKid: next.rootKid } });
      }
      await this.audit.log(tx, { actorId: actor.actorId, actorKind: 'platform', subjectType: 'root', subjectId: next.rootKid, subjectName: `root ${this.provider.rootKid} → ${next.rootKid}`, action: KEY_AUDIT_ACTIONS.rootRotated, reason: actor.reason, details: { versions: rows.length } });
    }
    return { versions: rows.length, fromRootKid: this.provider.rootKid, toRootKid: next.rootKid };
  }

  workspaceOf(scope: string): string | null {
    return scope.startsWith('workspace:') ? scope.slice('workspace:'.length) : null;
  }
}
