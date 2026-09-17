import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { KEYS_LIMITS, SIGNING_AUDIENCES, type KeyScopeRef, type SigningAudience } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { KEK_NAME, KEYS_JOBS, KEYS_QUEUE, KEY_AUDIT_ACTIONS, PLATFORM_SCOPE } from './keys.constants';
import { KeysAuditService } from './keys.audit.service';
import { KeysEnvelopeService } from './keys.envelope.service';
import { KeysFieldRegistry, type EncryptedColumnDef } from './keys.registry';
import { KeysSigningService } from './keys.signing.service';
import { KeysStoreService } from './keys.store.service';

/** Максимальный срок токена аудитории (секунд) — окно, пока старая версия подписи ещё проверяет. */
export const AUDIENCE_MAX_TTL_SEC: Record<SigningAudience, number> = {
  product: 30 * 86_400, // refresh 30 дней
  platform: 8 * 3600,
  wopi: 10 * 3600,
  share_link: 24 * 3600,
  files_url: 3600,
  webhook: 3600,
};

/**
 * Фон движка: активация/вывод версий подписи, перешивка DEK'ов после ротации KEK,
 * переиндексация слепых индексов, уничтожение по сроку; крон — автоматическая ротация
 * (подпись 90 дней, KEK год) и sweep. Батчи по 500 строк с курсором, идемпотентно,
 * своя очередь (тяжёлый тип — своя очередь, правило core/jobs).
 */
@Injectable()
export class KeysRotationJobs implements OnModuleInit {
  private readonly logger = new Logger(KeysRotationJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly store: KeysStoreService,
    private readonly envelope: KeysEnvelopeService,
    private readonly signing: KeysSigningService,
    private readonly fields: KeysFieldRegistry,
    private readonly audit: KeysAuditService,
  ) {}

  onModuleInit(): void {
    const opts = { queue: KEYS_QUEUE, maxAttempts: 10, leaseMs: 30 * 60_000, queueConcurrency: 1 };
    this.registry.register(KEYS_JOBS.signingActivate, (p) => this.signingActivate(p), { ...opts, maxAttempts: 20 });
    this.registry.register(KEYS_JOBS.signingRetire, (p) => this.signingRetire(p), { ...opts, maxAttempts: 20 });
    this.registry.register(KEYS_JOBS.rewrap, (p) => this.rewrap(p), opts);
    this.registry.register(KEYS_JOBS.reindex, (p) => this.reindex(p), opts);
    this.registry.register(KEYS_JOBS.destroySweep, () => this.destroySweep(), opts);
    this.registry.register(KEYS_JOBS.legacyReencrypt, async () => void (await this.reencryptLegacy()), opts);
  }

  // ------------------------------------------------------------
  // Строки прошлой эпохи → envelope (один проход на старте, идемпотентно)
  // ------------------------------------------------------------

  /** Все зарегистрированные колонки с `legacyDecrypt`: не-`sa6e:` строки перешиваются в envelope. */
  async reencryptLegacy(): Promise<number> {
    let total = 0;
    for (const def of this.fields.all()) {
      if (!def.legacyDecrypt) continue;
      total += await this.reencryptColumn(def);
    }
    if (total) this.logger.log(`legacy re-encrypt: ${total} rows`);
    return total;
  }

  private async reencryptColumn(def: EncryptedColumnDef): Promise<number> {
    const table = Prisma.raw(`"${def.table}"`);
    const col = Prisma.raw(`"${def.column}"`);
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    const scopeCol = def.scopeColumn ? Prisma.raw(`"${def.scopeColumn}"`) : null;
    let cursor = '';
    let total = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; value: string; owner: string | null }>>`
        SELECT ${idCol}::text AS id, ${col} AS value, ${scopeCol ? Prisma.sql`${scopeCol}::text` : Prisma.sql`NULL`} AS owner FROM ${table}
        WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE 'sa6e:%' AND ${idCol}::text > ${cursor}
        ORDER BY ${idCol}::text LIMIT ${KEYS_LIMITS.rewrapBatch}`;
      if (!rows.length) break;
      for (const row of rows) {
        const plain = def.legacyDecrypt!(row.value);
        if (plain === null) continue;
        const scope: KeyScopeRef = def.scope === 'platform' ? { type: 'platform' } : { type: def.scope, id: row.owner ?? '' };
        if (scope.type !== 'platform' && !scope.id) continue;
        const ctx = { entity: def.entity, field: def.field, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
        let next: string;
        try {
          next = await this.envelope.encrypt(scope, ctx, plain);
        } catch (err) {
          this.logger.warn(`legacy re-encrypt ${def.table}.${def.column} ${row.id}: ${(err as Error).message}`);
          continue;
        }
        // Только если строка не изменилась с момента чтения (параллельная запись уже envelope)
        await this.db.$executeRaw`UPDATE ${table} SET ${col} = ${next} WHERE ${idCol}::text = ${row.id} AND ${col} = ${row.value}`;
        total++;
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < KEYS_LIMITS.rewrapBatch) break;
    }
    return total;
  }

  // ------------------------------------------------------------
  // Подпись: pending → active → (окно) → destroy_scheduled
  // ------------------------------------------------------------

  async signingActivate(payload: Record<string, unknown>): Promise<void> {
    const kid = typeof payload.kid === 'string' ? payload.kid : null;
    if (!kid) throw new JobDiscardError('keys.signing.activate: kid missing');
    const activated = await this.store.activate(kid);
    const previousKid = typeof payload.previousKid === 'string' ? payload.previousKid : null;
    const retireAfterSec = typeof payload.retireAfterSec === 'number' ? payload.retireAfterSec : 0;
    if (previousKid && previousKid !== kid) {
      await this.jobs.enqueue(null, {
        type: KEYS_JOBS.signingRetire,
        payload: { kid: previousKid },
        runAt: new Date(Date.now() + (retireAfterSec + KEYS_LIMITS.jwksCacheSec) * 1000),
        uniqueKey: `retire:${previousKid}`,
      });
    }
    this.logger.log(`signing version ${kid} ${activated ? 'activated' : 'already active/other state'}`);
  }

  async signingRetire(payload: Record<string, unknown>): Promise<void> {
    const kid = typeof payload.kid === 'string' ? payload.kid : null;
    if (!kid) throw new JobDiscardError('keys.signing.retire: kid missing');
    const v = await this.store.version(kid);
    if (!v) return;
    const key = await this.store.getKey(v.scope, v.purpose, v.name);
    // Никогда не выводим текущую primary (ротация могла откатиться)
    if (key?.primaryKid === kid) return;
    await this.store.scheduleDestroy(kid, new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000), { actorKind: 'system', reason: 'rotation window elapsed' });
  }

  // ------------------------------------------------------------
  // KEK: перешивка DEK'ов зарегистрированных колонок на primary-версию
  // ------------------------------------------------------------

  async rewrap(payload: Record<string, unknown>): Promise<void> {
    const scope = typeof payload.scope === 'string' ? payload.scope : null;
    if (!scope) throw new JobDiscardError('keys.rewrap: scope missing');
    const ref = this.scopeRef(scope);
    if (!ref) throw new JobDiscardError(`keys.rewrap: bad scope ${scope}`);
    const key = await this.store.getKey(scope, 'kek', KEK_NAME);
    if (!key?.primaryKid) return;
    let total = 0;
    for (const def of this.fields.forScope(ref.type)) total += await this.rewrapColumn(def, ref, key.primaryKid);
    await this.audit.log(null, { actorKind: 'system', workspaceId: this.store.workspaceOf(scope), subjectType: 'crypto_key', subjectId: key.id, subjectName: `${scope}/kek`, action: KEY_AUDIT_ACTIONS.rewrapDone, details: { rows: total } });
    // Старые active-версии KEK больше никем не читаются → на вывод
    for (const v of key.versions) {
      if (v.kid !== key.primaryKid && v.state === 'active') {
        await this.store.scheduleDestroy(v.kid, new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000), { actorKind: 'system', reason: 'rewrapped to primary' });
      }
    }
    this.logger.log(`rewrap ${scope}: ${total} rows`);
  }

  private async rewrapColumn(def: EncryptedColumnDef, scope: KeyScopeRef, primaryKid: string): Promise<number> {
    const table = Prisma.raw(`"${def.table}"`);
    const col = Prisma.raw(`"${def.column}"`);
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    const scopeWhere = scope.type === 'platform' ? Prisma.sql`TRUE` : Prisma.sql`${Prisma.raw(`"${def.scopeColumn!}"`)} = ${scope.id}`;
    let cursor = '';
    let total = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; value: string }>>`
        SELECT ${idCol}::text AS id, ${col} AS value FROM ${table}
        WHERE ${scopeWhere} AND ${col} LIKE 'sa6e:1:%' AND ${col} NOT LIKE ${`sa6e:1:${primaryKid}:%`}
          AND ${idCol}::text > ${cursor}
        ORDER BY ${idCol}::text LIMIT ${KEYS_LIMITS.rewrapBatch}`;
      if (!rows.length) break;
      for (const row of rows) {
        const ctx = { entity: def.entity, field: def.field, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
        let next: string;
        try {
          next = await this.envelope.rewrap(scope, ctx, row.value);
        } catch (err) {
          this.logger.warn(`rewrap ${def.table}.${def.column} ${row.id}: ${(err as Error).message}`);
          continue;
        }
        if (next !== row.value) {
          // Только если строка не изменилась с момента чтения (иначе новая запись уже под primary)
          await this.db.$executeRaw`UPDATE ${table} SET ${col} = ${next} WHERE ${idCol}::text = ${row.id} AND ${col} = ${row.value}`;
          total++;
        }
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < KEYS_LIMITS.rewrapBatch) break;
    }
    return total;
  }

  // ------------------------------------------------------------
  // Слепые индексы: пересчёт на primary-версию mac-ключа (только при компрометации)
  // ------------------------------------------------------------

  async reindex(_payload: Record<string, unknown>): Promise<void> {
    const key = await this.store.getKey(PLATFORM_SCOPE, 'mac', 'blind_index');
    if (!key?.primaryKid) return;
    let total = 0;
    for (const def of this.fields.all()) {
      if (!def.blindIndex) continue;
      total += await this.reindexColumn(def, key.primaryKid);
    }
    for (const v of key.versions) {
      if (v.kid !== key.primaryKid && v.state === 'active') {
        await this.store.scheduleDestroy(v.kid, new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000), { actorKind: 'system', reason: 'reindexed to primary' });
      }
    }
    this.logger.log(`reindex: ${total} rows`);
  }

  private async reindexColumn(def: EncryptedColumnDef, primaryKid: string): Promise<number> {
    const bi = def.blindIndex!;
    const table = Prisma.raw(`"${def.table}"`);
    const col = Prisma.raw(`"${def.column}"`);
    const biCol = Prisma.raw(`"${bi.column}"`);
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    const scopeCol = def.scopeColumn ? Prisma.raw(`"${def.scopeColumn}"`) : null;
    let cursor = '';
    let total = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; value: string; owner: string | null }>>`
        SELECT ${idCol}::text AS id, ${col} AS value, ${scopeCol ? Prisma.sql`${scopeCol}::text` : Prisma.sql`NULL`} AS owner FROM ${table}
        WHERE ${biCol} LIKE 'sa6b:1:%' AND ${biCol} NOT LIKE ${`sa6b:1:${primaryKid}:%`} AND ${col} LIKE 'sa6e:1:%'
          AND ${idCol}::text > ${cursor}
        ORDER BY ${idCol}::text LIMIT ${KEYS_LIMITS.rewrapBatch}`;
      if (!rows.length) break;
      for (const row of rows) {
        const scope: KeyScopeRef = def.scope === 'platform' ? { type: 'platform' } : { type: def.scope, id: row.owner ?? '' };
        const ctx = { entity: def.entity, field: def.field, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
        const dec = await this.envelope.tryDecrypt(scope, ctx, row.value);
        if (!dec.ok) continue;
        const next = await this.envelope.blindIndex(bi.name, bi.normalize(dec.value));
        await this.db.$executeRaw`UPDATE ${table} SET ${biCol} = ${next} WHERE ${idCol}::text = ${row.id}`;
        total++;
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < KEYS_LIMITS.rewrapBatch) break;
    }
    return total;
  }

  async destroySweep(): Promise<void> {
    const n = await this.store.destroyDue();
    if (n) this.logger.log(`destroyed ${n} key versions past their schedule`);
  }

  // ------------------------------------------------------------
  // Крон: ротация по возрасту + sweep
  // ------------------------------------------------------------

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async daily(): Promise<void> {
    await this.redis.withLock('cron:keys:daily', 600, async () => {
      await this.rotateAgedSigning();
      await this.rotateAgedKeks();
      await this.jobs.enqueue(null, { type: KEYS_JOBS.destroySweep, payload: {}, uniqueKey: `sweep:${new Date().toISOString().slice(0, 10)}` });
    });
  }

  /** Подпись: primary старше `signingRotationDays` → ротация с перекрытием. */
  async rotateAgedSigning(): Promise<number> {
    let n = 0;
    const cutoff = Date.now() - KEYS_LIMITS.signingRotationDays * 86_400_000;
    for (const aud of SIGNING_AUDIENCES) {
      const key = await this.store.getKey(PLATFORM_SCOPE, 'sign', aud);
      if (!key?.primaryKid) continue;
      const primary = key.versions.find((v) => v.kid === key.primaryKid);
      const pending = key.versions.some((v) => v.state === 'pending');
      if (!primary || pending || (primary.activatedAt ?? primary.createdAt).getTime() > cutoff) continue;
      await this.signing.rotate(aud, { reason: 'age', retireAfterSec: AUDIENCE_MAX_TTL_SEC[aud] });
      n++;
    }
    return n;
  }

  /** KEK старше `kekRotationDays` → новая active-версия + джоб перешивки. Батчами по 200 ключей за прогон. */
  async rotateAgedKeks(): Promise<number> {
    const cutoff = new Date(Date.now() - KEYS_LIMITS.kekRotationDays * 86_400_000);
    const aged = await this.db.cryptoKey.findMany({
      where: { purpose: 'kek', versions: { some: { state: 'active', activatedAt: { lt: cutoff } } } },
      include: { versions: { where: { state: 'active' } } },
      take: 200,
    });
    let n = 0;
    for (const key of aged) {
      const primary = key.versions.find((v) => v.id === key.primaryVersionId);
      if (!primary || !primary.activatedAt || primary.activatedAt >= cutoff) continue;
      await this.rotateKek(key.scope, { reason: 'age' });
      n++;
    }
    return n;
  }

  /** Ротация KEK скоупа: новая primary + фоновая перешивка. */
  async rotateKek(scope: string, actor: { actorId?: string | null; reason?: string | null }): Promise<string> {
    const key = await this.store.ensureKey(scope, 'kek', KEK_NAME);
    const kid = await this.store.createVersion(key.id, 'active', { actorId: actor.actorId ?? null, actorKind: actor.actorId ? 'platform' : 'system', reason: actor.reason ?? null });
    await this.jobs.enqueue(null, { type: KEYS_JOBS.rewrap, payload: { scope }, uniqueKey: `rewrap:${scope}:${kid}` });
    return kid;
  }

  private scopeRef(scope: string): KeyScopeRef | null {
    if (scope === PLATFORM_SCOPE) return { type: 'platform' };
    if (scope.startsWith('workspace:')) return { type: 'workspace', id: scope.slice('workspace:'.length) };
    if (scope.startsWith('user:')) return { type: 'user', id: scope.slice('user:'.length) };
    return null;
  }
}
