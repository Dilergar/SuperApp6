import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type CryptoKey, type CryptoKeyVersion } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, KEY_ALGORITHMS, type KeyPurpose, type KeyVersionState } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
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
  /** Слот слепого индекса (0 → `_bi`, 1 → `_bi_alt`); только у версий mac-ключа `blind_index` */
  slot: number | null;
  createdAt: Date;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  destroyScheduledAt: Date | null;
  destroyedAt: Date | null;
  /** Метка компрометации: архивная проверка подписи отвергает версию навсегда */
  compromisedAt: Date | null;
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

/** Имя mac-ключа слепых индексов: его версии несут слот-колонку. */
export const BLIND_INDEX_KEY = 'blind_index';

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

  /**
   * Мутация шла в ЧУЖОЙ транзакции: сбрасывать эпоху до её коммита бессмысленно и вредно —
   * параллельное чтение увидит ещё старое состояние и положит его в кэш уже с новой эпохой
   * (замороженный ключ жил бы до TTL кэша). Поэтому: вызывающий ОБЯЗАН позвать `bumpEpoch()`
   * после коммита (мгновенный эффект), а здесь — страховка на все пути: отложенные сбросы,
   * которые переживают забытый вызов и долгую транзакцию (2 с / 15 с / 60 с, таймеры unref).
   */
  private bumpAfterForeignTx(): void {
    for (const ms of KEYS_LIMITS.foreignTxEpochBumpsMs) {
      const t = setTimeout(() => void this.bumpEpoch(), ms);
      t.unref?.();
    }
  }

  /** Сбросить ТОЛЬКО локальные кэши (неизвестный `kid` от соседа): перечитать без INCR эпохи. */
  async bumpEpochLocalOnly(): Promise<void> {
    this.keyCache.clear();
    this.versionCache.clear();
    this.epochAt = 0;
    await this.epoch();
  }

  /** Своя транзакция уже закоммичена → сброс сразу; чужая → после её коммита (см. `bumpAfterForeignTx`). */
  private async bumpAfter(tx: Tx | undefined): Promise<void> {
    if (tx) this.bumpAfterForeignTx();
    else await this.bumpEpoch();
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
          slot: v.slot,
          createdAt: v.createdAt,
          activatedAt: v.activatedAt,
          deactivatedAt: v.deactivatedAt,
          destroyScheduledAt: v.destroyScheduledAt,
          destroyedAt: v.destroyedAt,
          compromisedAt: v.compromisedAt,
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
      material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial), this.wrapAad(row.id, purpose), row.rootKid);
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
      slot: row.slot,
      createdAt: row.createdAt,
      activatedAt: row.activatedAt,
      deactivatedAt: row.deactivatedAt,
      destroyScheduledAt: row.destroyScheduledAt,
      destroyedAt: row.destroyedAt,
      compromisedAt: row.compromisedAt,
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
          material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial), this.wrapAad(row.id, purpose), row.rootKid);
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
          slot: row.slot,
          createdAt: row.createdAt,
          activatedAt: row.activatedAt,
          deactivatedAt: row.deactivatedAt,
          destroyScheduledAt: row.destroyScheduledAt,
          destroyedAt: row.destroyedAt,
          compromisedAt: row.compromisedAt,
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
    const wrapRoot = await this.wrapRootKid();
    const wrapped = await this.provider.wrap(material, this.wrapAad(kid, purpose), wrapRoot);
    const last = await tx.cryptoKeyVersion.aggregate({ where: { keyId: key.id }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const now = new Date();
    // Слепой индекс: каждая версия пишет в СВОЙ слот-колонку (`_bi` / `_bi_alt`) — новая версия
    // получает слот, противоположный primary, и в колонке никогда не смешиваются две версии
    let slot: number | null = null;
    if (purpose === 'mac' && key.name === BLIND_INDEX_KEY) {
      // Сразу-`active` вторая версия стала бы primary с ПУСТЫМ слотом: поиск по номеру перестал бы
      // находить всех разом. Смена идёт только pending → заполнение слота → активация.
      if (state === 'active' && key.primaryVersionId) {
        throw new Error('keystore: the blind_index key rotates only through the pending → fill → activate sequence (KeysRotationJobs.rotateBlindIndex)');
      }
      const primary = key.primaryVersionId ? await tx.cryptoKeyVersion.findUnique({ where: { id: key.primaryVersionId }, select: { slot: true } }) : null;
      slot = primary ? ((primary.slot ?? 0) === 0 ? 1 : 0) : 0;
    }
    await tx.cryptoKeyVersion.create({
      data: {
        id: kid,
        keyId: key.id,
        version,
        state,
        wrappedMaterial: bytes(wrapped),
        publicKey: publicKey ? bytes(publicKey) : null,
        rootKid: wrapRoot,
        slot,
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
      details: { state, rootKid: wrapRoot, ...(slot !== null ? { slot } : {}) },
    });
    return kid;
  }

  /** Публичная ротация: новая версия (`pending` для подписи — активируется джобом, `active` для KEK/MAC). */
  async createVersion(
    keyId: string,
    state: 'pending' | 'active',
    actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {},
    /** В ТОЙ ЖЕ транзакции, что и версия: джоб активации/перешивки не теряется при падении между шагами */
    inTx?: (tx: Tx, kid: string) => Promise<void>,
  ): Promise<string> {
    const kid = await this.db.$transaction(async (tx) => {
      // Две ротации одного ключа разом дали бы две версии с одним номером — сериализуем по ключу
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`keys:version:${keyId}`}))`;
      const key = await tx.cryptoKey.findUniqueOrThrow({ where: { id: keyId } });
      const id = await this.createVersionTx(tx, key, state);
      if (inTx) await inTx(tx, id);
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
    if (ok) await this.bumpAfter(tx);
    return ok;
  }

  /**
   * Признать версию скомпрометированной. Метка `compromisedAt` ставится при ЛЮБОМ состоянии
   * (в т.ч. `destroyed`: закрытый ключ могли унести до уничтожения) и не снимается никогда —
   * `enable` её не трогает. Рабочая версия (`active`/`pending`) заодно выключается. Primary
   * не помечается: сначала вызывающий переводит primary на новую версию (`KeysSigningService.compromise`).
   */
  async markCompromised(kid: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v || v.key.primaryVersionId === kid) return false;
      const now = new Date();
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, compromisedAt: null }, data: { compromisedAt: now } });
      if (count === 0) return false;
      await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['active', 'pending'] } }, data: { state: 'disabled', deactivatedAt: now, frozenFrom: null } });
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionCompromised, reason: actor.reason ?? null, details: { stateBefore: v.state } });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpAfter(tx);
    return ok;
  }

  /** `disabled` | `destroy_scheduled` → `active` (восстановление; primary-указатель ключа не менялся). */
  async enable(kid: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['disabled', 'destroy_scheduled'] }, compromisedAt: null }, data: { state: 'active', deactivatedAt: null, destroyScheduledAt: null, frozenFrom: null } });
      if (count === 0) return false;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionEnabled, reason: actor.reason ?? null });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpAfter(tx);
    return ok;
  }

  /** Назначить уничтожение (после `destroyDelayDays`); восстановимо через `enable`. Уже primary нельзя. */
  async scheduleDestroy(kid: string, at: Date, actor: { actorId?: string | null; actorKind?: string; reason?: string | null } = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const v = await t.cryptoKeyVersion.findUnique({ where: { id: kid }, include: { key: true } });
      if (!v) return false;
      // Primary не выводится поштучно никогда: ключ остался бы без рабочей версии, а данные под
      // ним — нечитаемыми. Субъект целиком уходит через `scheduleScopeDestroy`.
      if (v.key.primaryVersionId === kid) {
        this.logger.warn(`refused to schedule destroy of the primary version ${kid} (${v.key.scope}/${v.key.purpose}/${v.key.name})`);
        return false;
      }
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { id: kid, state: { in: ['active', 'disabled', 'pending'] } }, data: { state: 'destroy_scheduled', destroyScheduledAt: at, deactivatedAt: v.deactivatedAt ?? new Date(), frozenFrom: null } });
      if (count === 0) return false;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(v.key.scope), subjectType: 'key_version', subjectId: kid, subjectName: `${v.key.scope}/${v.key.purpose}/${v.key.name} v${v.version}`, action: KEY_AUDIT_ACTIONS.versionDestroyScheduled, reason: actor.reason ?? null, details: { at: at.toISOString() } });
      return true;
    };
    const ok = tx ? await run(tx) : await this.db.$transaction(run);
    if (ok) await this.bumpAfter(tx);
    return ok;
  }

  /** Уничтожить материал (crypto-shredding). Только из `destroy_scheduled` и только по сроку. */
  async destroyDue(now = new Date()): Promise<number> {
    let n = 0;
    for (let page = 0; page < 500; page++) {
      const done = await this.destroyDuePage(now);
      n += done.destroyed;
      if (done.seen < 200) break;
    }
    if (n) await this.bumpEpoch();
    return n;
  }

  private async destroyDuePage(now: Date): Promise<{ seen: number; destroyed: number }> {
    const due = await this.db.cryptoKeyVersion.findMany({ where: { state: 'destroy_scheduled', destroyScheduledAt: { lte: now } }, include: { key: true }, orderBy: { destroyScheduledAt: 'asc' }, take: 200 });
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
    return { seen: due.length, destroyed: n };
  }

  // ------------------------------------------------------------
  // Скоуп целиком (организация / человек): заморозка и шреддинг
  // ------------------------------------------------------------

  /** Kill-switch: все версии скоупа → `disabled` — данные субъекта нечитаемы мгновенно. */
  async freezeScope(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      // Состояние ДО заморозки запоминается в `frozen_from` (колонка → колонка, поэтому сырой SQL):
      // разморозка вернёт ровно его и не тронет версии, выключенные поштучно (у тех `frozen_from` пуст)
      const count = await t.$executeRaw`
        UPDATE "crypto_key_versions" SET "frozen_from" = "state", "state" = 'disabled', "deactivated_at" = ${utcTs(new Date())}
        WHERE "key_id" = ANY(${keys.map((k) => k.id)}::uuid[]) AND "state" IN ('active', 'pending')`;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'platform', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.scopeFrozen, reason: actor.reason ?? null, details: { versions: count } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpAfter(tx);
    return n;
  }

  async unfreezeScope(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      // Только версии, выключенные САМОЙ заморозкой: `pending` возвращается в `pending`, а версия,
      // выключенная поштучно (подозрение на утечку), остаётся выключенной
      const count = await t.$executeRaw`
        UPDATE "crypto_key_versions" SET "state" = "frozen_from", "frozen_from" = NULL, "deactivated_at" = NULL
        WHERE "key_id" = ANY(${keys.map((k) => k.id)}::uuid[]) AND "state" = 'disabled' AND "frozen_from" IN ('active', 'pending')`;
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'platform', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.scopeUnfrozen, reason: actor.reason ?? null, details: { versions: count } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpAfter(tx);
    return n;
  }

  /** Шреддинг субъекта: все версии скоупа → `destroy_scheduled` через `destroyDelayDays` (восстановимо до срока). */
  async scheduleScopeDestroy(scope: string, actor: { actorId?: string | null; actorKind?: string; reason?: string | null }, tx?: Tx): Promise<number> {
    const at = new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000);
    const run = async (t: Tx) => {
      const keys = await t.cryptoKey.findMany({ where: { scope }, select: { id: true } });
      if (!keys.length) return 0;
      const { count } = await t.cryptoKeyVersion.updateMany({ where: { keyId: { in: keys.map((k) => k.id) }, state: { in: ['active', 'pending', 'disabled'] } }, data: { state: 'destroy_scheduled', destroyScheduledAt: at, deactivatedAt: new Date(), frozenFrom: null } });
      await this.audit.log(t, { actorId: actor.actorId ?? null, actorKind: actor.actorKind ?? 'system', workspaceId: this.workspaceOf(scope), subjectType: 'crypto_key', subjectId: scope, subjectName: scope, action: KEY_AUDIT_ACTIONS.versionDestroyScheduled, reason: actor.reason ?? null, details: { versions: count, at: at.toISOString() } });
      return count;
    };
    const n = tx ? await run(tx) : await this.db.$transaction(run);
    await this.bumpAfter(tx);
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

  /** Корни, которые держит инстанс: текущий и (на окне ротации) следующий. */
  knownRootKids(): string[] {
    return this.provider.nextRootKid ? [this.provider.rootKid, this.provider.nextRootKid] : [this.provider.rootKid];
  }

  /** Версии, обёрнутые корнем, которого у инстанса нет (смоук бута: файл не тот — отказ, а не тихие ошибки на первом запросе). */
  async versionsWithForeignRoot(): Promise<number> {
    return this.db.cryptoKeyVersion.count({ where: { state: { not: 'destroyed' }, rootKid: { notIn: this.knownRootKids() } } });
  }

  // ------------------------------------------------------------
  // Ротация корня: окно двух корней, перешивка порциями
  // ------------------------------------------------------------

  private rootRotationStartedFlag = false;

  /**
   * Ротация корня НАЧАТА ⇔ в keystore есть хоть одна версия под следующим корнем. Флаг выводится
   * из самих данных (ни Redis, ни отдельной таблицы): началась — уже не «разначнётся», поэтому
   * кэшируется только истина.
   */
  async rootRotationStarted(): Promise<boolean> {
    const next = this.provider.nextRootKid;
    if (!next) return false;
    if (this.rootRotationStartedFlag) return true;
    const any = await this.db.cryptoKeyVersion.findFirst({ where: { rootKid: next }, select: { id: true } });
    if (any) this.rootRotationStartedFlag = true;
    return this.rootRotationStartedFlag;
  }

  /** Каким корнем оборачивать НОВУЮ версию: после начала ротации — следующим (иначе хвост под старым не кончался бы). */
  private async wrapRootKid(): Promise<string> {
    const next = this.provider.nextRootKid;
    return next && (await this.rootRotationStarted()) ? next : this.provider.rootKid;
  }

  async rootRotationStatus(): Promise<{ rootKid: string; nextRootKid: string | null; underCurrent: number; underNext: number; foreign: number }> {
    const live = { state: { not: 'destroyed' }, wrappedMaterial: { not: null } } as const;
    const next = this.provider.nextRootKid;
    const [underCurrent, underNext, foreign] = await Promise.all([
      this.db.cryptoKeyVersion.count({ where: { ...live, rootKid: this.provider.rootKid } }),
      next ? this.db.cryptoKeyVersion.count({ where: { ...live, rootKid: next } }) : Promise.resolve(0),
      this.versionsWithForeignRoot(),
    ]);
    return { rootKid: this.provider.rootKid, nextRootKid: next, underCurrent, underNext, foreign };
  }

  /**
   * Одна порция перешивки: версии под ТЕКУЩИМ корнем → под следующий. Каждая версия — свой
   * короткий UPDATE под гардом `root_kid = текущий` (а не одна транзакция на весь keystore:
   * у каждого человека и организации свой KEK, и сотни тысяч строк в одной транзакции не
   * уложились бы ни в память, ни в таймаут). Промежуточное состояние — рабочее: инстансы
   * держат оба корня, а каким открыть — говорит сама строка. Возвращает число перешитых.
   */
  async rewrapRootBatch(limit: number): Promise<number> {
    const next = this.provider.nextRootKid;
    if (!next) return 0;
    const rows = await this.db.cryptoKeyVersion.findMany({
      where: { rootKid: this.provider.rootKid, state: { not: 'destroyed' }, wrappedMaterial: { not: null } },
      include: { key: { select: { purpose: true } } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    let n = 0;
    for (const row of rows) {
      const aad = this.wrapAad(row.id, row.key.purpose as KeyPurpose);
      const material = await this.provider.unwrap(Buffer.from(row.wrappedMaterial!), aad, row.rootKid);
      const wrapped = await this.provider.wrap(material, aad, next);
      const { count } = await this.db.cryptoKeyVersion.updateMany({ where: { id: row.id, rootKid: this.provider.rootKid }, data: { wrappedMaterial: bytes(wrapped), rootKid: next } });
      n += count;
    }
    if (n) this.rootRotationStartedFlag = true;
    return n;
  }

  workspaceOf(scope: string): string | null {
    return scope.startsWith('workspace:') ? scope.slice('workspace:'.length) : null;
  }
}
