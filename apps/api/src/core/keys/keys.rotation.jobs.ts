import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as os from 'node:os';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { KEYS_ERROR_CODES, KEYS_LIMITS, KEYS_REDIS, SIGNING_AUDIENCES, type KeyScopeRef, type SigningAudience } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { badRequest, conflict } from '../../shared/errors/api-error';
import { RedisService } from '../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { KEK_NAME, KEYS_JOBS, KEYS_QUEUE, KEY_AUDIT_ACTIONS, PLATFORM_SCOPE } from './keys.constants';
import { KeysAuditService } from './keys.audit.service';
import { KeysEnvelopeService, slotOf } from './keys.envelope.service';
import { KeysFieldRegistry, type EncryptedColumnDef } from './keys.registry';
import { KeysSigningService } from './keys.signing.service';
import { BLIND_INDEX_KEY, KeysStoreService, type LoadedVersion } from './keys.store.service';

/** Максимальный срок токена аудитории (секунд) — окно, пока старая версия подписи ещё проверяет. */
export const AUDIENCE_MAX_TTL_SEC: Record<SigningAudience, number> = {
  product: 30 * 86_400, // refresh 30 дней
  platform: 8 * 3600,
  wopi: 10 * 3600,
  share_link: 24 * 3600,
  files_url: 3600,
  webhook: 3600,
  // Подписи версий согласий живут годами и проверяются `verifyArchival` (по окну жизни версии),
  // поэтому старой версии незачем оставаться `active` дольше кэша соседних инстансов
  consents: 3600,
  // Дайджесты и манифесты архива журнала безопасности — так же архивные (`verifyArchival`)
  audit: 3600,
  // Сертификаты стирания — архивные (`verifyArchival` по окну жизни версии)
  lifecycle: 3600,
};

/**
 * Имя таблицы для сырого SQL перешивки: со схемой, если колонка живёт не в `public`
 * (служебные хранилища движков — `idem.responses`). Идентификаторы валидированы
 * реестром (`KeysFieldRegistry.register`), пользовательского ввода тут нет.
 */
const qualifiedTable = (def: EncryptedColumnDef): Prisma.Sql =>
  Prisma.raw(def.schema ? `"${def.schema}"."${def.table}"` : `"${def.table}"`);

/**
 * Фон движка: активация/вывод версий подписи, перешивка DEK'ов после ротации KEK,
 * переиндексация слепых индексов, уничтожение по сроку; крон — автоматическая ротация
 * (подпись 90 дней, KEK год) и sweep. Батчи по 500 строк с курсором, идемпотентно,
 * своя очередь (тяжёлый тип — своя очередь, правило core/jobs).
 */
@Injectable()
export class KeysRotationJobs implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KeysRotationJobs.name);
  /** Имя инстанса в перекличке (`keys:instances`) */
  private readonly instanceId = `${os.hostname()}:${process.pid}`;

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
    this.registry.register(KEYS_JOBS.blindIndexRetire, (p) => this.blindIndexRetire(p), opts);
    this.registry.register(KEYS_JOBS.rootRewrap, () => this.rootRewrap(), { ...opts, maxAttempts: 20 });
    this.registry.register(KEYS_JOBS.destroySweep, () => this.destroySweep(), opts);
    this.registry.register(KEYS_JOBS.legacyReencrypt, async () => void (await this.reencryptLegacy()), opts);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.announce();
    // Ротация корня начата, а версии под старым корнем остались (рестарт посреди перешивки) — продолжить
    await this.resumeRootRewrap().catch((err: unknown) => this.logger.warn(`root rewrap resume: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Штатная остановка: инстанс уходит из переклички сам (убитый жёстко — исчезнет через `instanceStaleSec`). */
  async onModuleDestroy(): Promise<void> {
    await this.redis.getClient().hdel(KEYS_REDIS.instances, this.instanceId).catch(() => undefined);
  }

  /** Дискриминатор полиморфного владельца (`owner_type = 'workspace'`): одна колонка id на два вида скоупа. */
  private discriminatorWhere(def: EncryptedColumnDef): Prisma.Sql {
    return def.scopeDiscriminator ? Prisma.sql`${Prisma.raw(`"${def.scopeDiscriminator.column}"`)} = ${def.scopeDiscriminator.value}` : Prisma.sql`TRUE`;
  }

  /** Строки колонки, принадлежащие скоупу (у платформенной колонки — все). */
  private ownerWhere(def: EncryptedColumnDef, scope: KeyScopeRef): Prisma.Sql {
    if (scope.type === 'platform') return this.discriminatorWhere(def);
    return Prisma.sql`${Prisma.raw(`"${def.scopeColumn!}"`)}::text = ${scope.id} AND ${this.discriminatorWhere(def)}`;
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

  /** Курсор пачек по id: числовой у целых id (индекс работает), иначе — по тексту. */
  private readonly idTypes = new Map<string, 'bigint' | 'uuid' | 'text'>();

  /**
   * Курсор и равенство по НАСТОЯЩЕМУ типу ключа (из каталога): приведение колонки к тексту
   * (`"id"::text = $1`) отключало индекс — перешивка шла сканом таблицы (партиций) на каждую
   * строку: `idem.responses` — 5,5 мс на строку, десятки минут на скоуп.
   */
  private async idCursor(def: EncryptedColumnDef) {
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    // Сортировка — по колонке ТАБЛИЦЫ: голое имя совпало бы с псевдонимом вывода `id` (текст)
    const ordered = Prisma.sql`${qualifiedTable(def)}.${idCol}`;
    const cacheKey = `${def.schema ?? 'public'}.${def.table}.${def.idColumn}`;
    let type = def.idNumeric ? 'bigint' : this.idTypes.get(cacheKey);
    if (!type) {
      const [row] = await this.db.$queryRaw<Array<{ t: string | null }>>`
        SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
         WHERE a.attrelid = to_regclass(${`"${def.schema ?? 'public'}"."${def.table}"`}) AND a.attname = ${def.idColumn} AND NOT a.attisdropped`;
      type = row?.t === 'uuid' ? 'uuid' : row?.t === 'bigint' || row?.t === 'integer' ? 'bigint' : 'text';
      this.idTypes.set(cacheKey, type);
    }
    if (type === 'bigint') {
      return {
        start: '0',
        gt: (cursor: string) => Prisma.sql`${idCol} > ${cursor}::bigint`,
        order: ordered,
        eq: (id: string) => Prisma.sql`${idCol} = ${id}::bigint`,
      };
    }
    if (type === 'uuid') {
      return {
        start: '00000000-0000-0000-0000-000000000000',
        gt: (cursor: string) => Prisma.sql`${idCol} > ${cursor}::uuid`,
        order: ordered,
        eq: (id: string) => Prisma.sql`${idCol} = ${id}::uuid`,
      };
    }
    return {
      start: '',
      gt: (cursor: string) => Prisma.sql`${idCol} > ${cursor}`,
      order: ordered,
      eq: (id: string) => Prisma.sql`${idCol} = ${id}`,
    };
  }

  private async reencryptColumn(def: EncryptedColumnDef): Promise<number> {
    const table = qualifiedTable(def);
    const col = Prisma.raw(`"${def.column}"`);
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    const scopeCol = def.scopeColumn ? Prisma.raw(`"${def.scopeColumn}"`) : null;
    const ids = await this.idCursor(def);
    let cursor = ids.start;
    let total = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; value: string; owner: string | null }>>`
        SELECT ${idCol}::text AS id, ${col} AS value, ${scopeCol ? Prisma.sql`${scopeCol}::text` : Prisma.sql`NULL`} AS owner FROM ${table}
        WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE 'sa6e:%' AND ${this.discriminatorWhere(def)} AND ${ids.gt(cursor)}
        ORDER BY ${ids.order} LIMIT ${KEYS_LIMITS.rewrapBatch}`;
      if (!rows.length) break;
      const updates: Array<{ id: string; prev: string; next: string }> = [];
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
        updates.push({ id: row.id, prev: row.value, next });
      }
      // Страница — одной транзакцией (коммит на строку = fsync WAL на каждую).
      // Только если строка не изменилась с момента чтения (параллельная запись уже envelope)
      if (updates.length) {
        await this.db.$transaction(async (tx) => {
          for (const u of updates) await tx.$executeRaw`UPDATE ${table} SET ${col} = ${u.next} WHERE ${ids.eq(u.id)} AND ${col} = ${u.prev}`;
        }, { timeout: 60_000 });
        total += updates.length;
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
    const defs = this.fields.forScope(ref.type);
    await this.reviveReferencedVersions(defs, ref, key);
    let total = 0;
    let broken = 0;
    for (const def of defs) {
      const r = await this.rewrapColumn(def, ref, key.primaryKid);
      total += r.rewrapped;
      broken += r.broken;
    }
    // Старую версию выводим ТОЛЬКО если под ней не осталось ни одной строки: строка, которую
    // не удалось перешить (транзиентный сбой, запись инстансом с ещё тёплым кэшем старого
    // primary), после `destroy_scheduled` стала бы нечитаемой сразу, а через 30 дней — навсегда.
    let remaining = 0;
    for (const def of defs) remaining += await this.countUnderOtherVersions(def, ref, key.primaryKid);
    await this.audit.log(null, { actorKind: 'system', workspaceId: this.store.workspaceOf(scope), subjectType: 'crypto_key', subjectId: key.id, subjectName: `${scope}/kek`, action: KEY_AUDIT_ACTIONS.rewrapDone, details: { rows: total, remaining, broken } });
    if (remaining > 0) {
      // Остались только заведомо битые строки (не открываются и старым ключом) — повтор их не
      // вылечит; старые версии остаются `active` (данные целы), разбирается человек по логу.
      if (remaining <= broken) {
        this.logger.warn(`rewrap ${scope}: ${remaining} unreadable row(s) stay under old KEK versions — old versions are kept active`);
        return;
      }
      throw new Error(`rewrap ${scope}: ${remaining} row(s) still under old KEK versions (${total} rewrapped) — old versions are kept, the job retries`);
    }
    // Метаданные перечитываются: проход мог вернуть в строй версии, на которые ссылались строки
    const fresh = (await this.store.getKey(scope, 'kek', KEK_NAME)) ?? key;
    for (const v of fresh.versions) {
      if (v.kid !== fresh.primaryKid && v.state === 'active') {
        await this.store.scheduleDestroy(v.kid, new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000), { actorKind: 'system', reason: 'rewrapped to primary' });
      }
    }
    this.logger.log(`rewrap ${scope}: ${total} rows`);
  }

  /**
   * Самолечение: версия KEK уже выведена (`destroy_scheduled`), а строки под ней остались —
   * колонка попала в реестр позже ротации либо перешивка когда-то прошла мимо неё. Пока срок
   * уничтожения не наступил, версия возвращается в `active`, строки перешиваются этим же
   * проходом, и версия выводится заново уже пустой. Уничтоженную (`destroyed`) не вернуть.
   */
  private async reviveReferencedVersions(defs: EncryptedColumnDef[], scope: KeyScopeRef, key: { primaryKid: string | null; versions: Array<{ kid: string; state: string }> }): Promise<void> {
    const scheduled = new Set(key.versions.filter((v) => v.state === 'destroy_scheduled').map((v) => v.kid));
    if (!scheduled.size || !key.primaryKid) return;
    const referenced = new Set<string>();
    for (const def of defs) {
      const col = Prisma.raw(`"${def.column}"`);
      const rows = await this.db.$queryRaw<Array<{ kid: string }>>`
        SELECT DISTINCT split_part(${col}, ':', 3) AS kid FROM ${qualifiedTable(def)}
        WHERE ${this.ownerWhere(def, scope)} AND ${col} LIKE 'sa6e:1:%' AND ${col} NOT LIKE ${`sa6e:1:${key.primaryKid}:%`}`;
      for (const r of rows) if (scheduled.has(r.kid)) referenced.add(r.kid);
    }
    for (const kid of referenced) {
      const ok = await this.store.enable(kid, { actorKind: 'system', reason: 'rows still reference this version — restored for the rewrap' });
      if (ok) this.logger.warn(`rewrap: key version ${kid} was scheduled for destroy while rows still reference it — restored until they are rewrapped`);
    }
  }

  /** Версии нет вовсе либо её материал уничтожен — строку под ней не открыть уже никогда. */
  private async versionIsGone(kid: string | null): Promise<boolean> {
    if (!kid) return true;
    try {
      const v = await this.store.version(kid);
      return !v || v.state === 'destroyed' || !v.material;
    } catch {
      return false; // корень не открыл обёртку — это сбой среды, а не приговор строке
    }
  }

  /** Сколько строк колонки этого скоупа всё ещё лежит НЕ под primary-версией KEK. */
  private async countUnderOtherVersions(def: EncryptedColumnDef, scope: KeyScopeRef, primaryKid: string): Promise<number> {
    const table = qualifiedTable(def);
    const col = Prisma.raw(`"${def.column}"`);
    const rows = await this.db.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n FROM ${table}
      WHERE ${this.ownerWhere(def, scope)} AND ${col} LIKE 'sa6e:1:%' AND ${col} NOT LIKE ${`sa6e:1:${primaryKid}:%`}`;
    return Number(rows[0]?.n ?? 0);
  }

  private async rewrapColumn(def: EncryptedColumnDef, scope: KeyScopeRef, primaryKid: string): Promise<{ rewrapped: number; broken: number }> {
    const table = qualifiedTable(def);
    const col = Prisma.raw(`"${def.column}"`);
    const idCol = Prisma.raw(`"${def.idColumn}"`);
    const ctx = { entity: def.entity, field: def.field, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
    const ids = await this.idCursor(def);
    let cursor = ids.start;
    let rewrapped = 0;
    let broken = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; value: string }>>`
        SELECT ${idCol}::text AS id, ${col} AS value FROM ${table}
        WHERE ${this.ownerWhere(def, scope)} AND ${col} LIKE 'sa6e:1:%' AND ${col} NOT LIKE ${`sa6e:1:${primaryKid}:%`}
          AND ${ids.gt(cursor)}
        ORDER BY ${ids.order} LIMIT ${KEYS_LIMITS.rewrapBatch}`;
      if (!rows.length) break;
      const updates: Array<{ id: string; prev: string; next: string }> = [];
      for (const row of rows) {
        // Исход расшифровки различает «строка бита» (повтор не вылечит) и «ключ недоступен» (повтор нужен)
        const dec = await this.envelope.tryDecrypt(scope, ctx, row.value);
        if (!dec.ok) {
          // Бита навсегда: не наш формат/AAD/скоуп либо версия KEK уже уничтожена (материала нет).
          // «Ключ недоступен» при живой версии (заморозка скоупа) — транзиентно: повтор нужен.
          if (dec.error !== 'key_unavailable' || (await this.versionIsGone(this.envelope.kekKidOf(row.value)))) broken++;
          this.logger.warn(`rewrap ${def.table}.${def.column} ${row.id}: ${dec.error}`);
          continue;
        }
        let next: string;
        try {
          next = await this.envelope.encrypt(scope, ctx, dec.value);
        } catch (err) {
          this.logger.warn(`rewrap ${def.table}.${def.column} ${row.id}: ${(err as Error).message}`);
          continue;
        }
        updates.push({ id: row.id, prev: row.value, next });
      }
      // Страница — ОДНОЙ транзакцией: коммит на строку (fsync WAL на каждую) делал перешивку
      // большого скоупа часами. Синхронно, без асинхронного коммита: после перешивки старая
      // версия KEK уходит на уничтожение — потерянный коммит оставил бы строку под мёртвым ключом.
      // Только если строка не изменилась с момента чтения (иначе новая запись уже под primary)
      if (updates.length) {
        await this.db.$transaction(async (tx) => {
          for (const u of updates) await tx.$executeRaw`UPDATE ${table} SET ${col} = ${u.next} WHERE ${ids.eq(u.id)} AND ${col} = ${u.prev}`;
        }, { timeout: 60_000 });
        rewrapped += updates.length;
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < KEYS_LIMITS.rewrapBatch) break;
    }
    return { rewrapped, broken };
  }

  // ------------------------------------------------------------
  // Слепые индексы: смена ключа без простоя (два слота-колонки)
  //
  // Каждая версия mac-ключа `blind_index` пишет в СВОЙ слот (`_bi` — 0, `_bi_alt` — 1):
  //   1. `rotateBlindIndex` — новая версия `pending` в противоположном слоте; с этого момента
  //      каждая запись ПДн кладёт ОБА индекса (расширение Prisma), поиск идёт по primary;
  //   2. `keys.reindex` (через `rewrapDelaySec` — все инстансы уже знают про pending) заполняет
  //      слот pending у старых строк и, когда незаполненных не осталось, активирует версию:
  //      поиск одним движением переключается на заполненный слот;
  //   3. `keys.blindindex.retire` (ещё через `rewrapDelaySec`) выводит прежнюю версию и
  //      очищает её слот — он свободен под следующую смену.
  // В колонке всегда ровно одна версия ключа → уникальные индексы и `findUnique` по номеру
  // работают в любой момент смены.
  // ------------------------------------------------------------

  /** Начать смену ключа слепых индексов (только при компрометации; команда кабинета `keys.blindindex.rotate`). */
  async rotateBlindIndex(actor: { actorId?: string | null; reason?: string | null }): Promise<{ kid: string }> {
    const key = await this.store.ensureKey(PLATFORM_SCOPE, 'mac', BLIND_INDEX_KEY);
    const versions = await this.db.cryptoKeyVersion.findMany({ where: { keyId: key.id }, select: { id: true, state: true } });
    // Слотов два: пока прошлая смена не завершена (есть pending либо прежняя версия ещё `active`), третьей версии писать некуда
    if (versions.some((v) => v.state === 'pending' || (v.state === 'active' && v.id !== key.primaryKid))) {
      throw conflict('keys.rotation_in_progress', undefined, { code: KEYS_ERROR_CODES.rotationInProgress });
    }
    const kid = await this.store.createVersion(key.id, 'pending', { actorId: actor.actorId ?? null, actorKind: actor.actorId ? 'platform' : 'system', reason: actor.reason ?? null }, async (tx, id) => {
      await this.jobs.enqueue(tx, { type: KEYS_JOBS.reindex, payload: {}, uniqueKey: `reindex:${id}`, runAt: new Date(Date.now() + KEYS_LIMITS.rewrapDelaySec * 1000) });
    });
    return { kid };
  }

  /**
   * С pending-версией — заполнить её слот и активировать; без неё — починка рабочего слота
   * (строки размороженных скоупов, записи инстансов с протухшим кэшем). Идемпотентно.
   */
  async reindex(payload: Record<string, unknown>): Promise<void> {
    const key = await this.store.getKey(PLATFORM_SCOPE, 'mac', BLIND_INDEX_KEY);
    if (!key?.primaryKid) return;
    const pendingMeta = key.versions.find((v) => v.state === 'pending');
    // Раньше, чем кэш keystore протух на всех инстансах, слот заполнять нельзя: инстанс, ещё не
    // знающий про pending, пишет строки БЕЗ второго индекса — их пришлось бы досчитывать заново,
    // а активация до конца окна оставила бы их ненаходимыми. `force` — только учения дев-полигона.
    if (pendingMeta && payload.force !== true) {
      const readyAt = pendingMeta.createdAt.getTime() + KEYS_LIMITS.rewrapDelaySec * 1000;
      if (Date.now() < readyAt) {
        await this.jobs.enqueue(null, { type: KEYS_JOBS.reindex, payload: {}, uniqueKey: `reindex:${pendingMeta.kid}:wait`, runAt: new Date(readyAt) });
        return;
      }
    }
    const target = await this.store.version(pendingMeta?.kid ?? key.primaryKid);
    if (!target?.material) throw new Error(`reindex: blind index version ${pendingMeta?.kid ?? key.primaryKid} has no material`);
    const deadline = Date.now() + KEYS_LIMITS.heavyJobBudgetMs;
    const r = await this.fillBlindIndexSlot(target, deadline);
    if (r.timedOut) {
      // Продолжение — отдельным джобом: заход обязан уложиться в аренду очереди
      await this.jobs.enqueue(null, { type: KEYS_JOBS.reindex, payload: {}, uniqueKey: `reindex:cont:${Date.now()}` });
      this.logger.log(`reindex: ${r.filled} rows in this pass, continuing in the next job`);
      return;
    }
    if (!pendingMeta) {
      if (r.filled) this.logger.log(`reindex (repair): ${r.filled} rows brought under the primary blind index version`);
      return;
    }
    // Активируем только заполненный слот: не открывшиеся строки (замороженный/уничтоженный KEK) и
    // конфликты уникальности смену не держат — их досчитает починка после разморозки
    const remaining = await this.countOutsideSlot(target);
    if (remaining > r.unavailable + r.conflicts) {
      throw new Error(`reindex: ${remaining} row(s) are still outside the pending blind index slot (${r.filled} filled) — the job retries`);
    }
    const previousKid = key.primaryKid;
    // Status-guarded: второй такой же джоб (крон + отложенный) активацию не повторит и вывод не продублирует
    if (!(await this.store.activate(target.kid))) return;
    await this.audit.log(null, { actorKind: 'system', subjectType: 'crypto_key', subjectId: key.id, subjectName: `${PLATFORM_SCOPE}/mac/${BLIND_INDEX_KEY}`, action: KEY_AUDIT_ACTIONS.blindIndexRotated, details: { kid: target.kid, slot: slotOf(target), filled: r.filled, unavailable: r.unavailable, conflicts: r.conflicts } });
    await this.jobs.enqueue(null, { type: KEYS_JOBS.blindIndexRetire, payload: { kid: previousKid }, uniqueKey: `bi-retire:${previousKid}`, runAt: new Date(Date.now() + KEYS_LIMITS.rewrapDelaySec * 1000) });
    this.logger.log(`blind index switched to version ${target.kid} (slot ${slotOf(target)}): ${r.filled} rows filled, ${r.unavailable} unavailable, ${r.conflicts} conflicts`);
  }

  private slotColumn(def: EncryptedColumnDef, version: { slot: number | null }): Prisma.Sql {
    return Prisma.raw(`"${slotOf(version) === 0 ? def.blindIndex!.column : def.blindIndex!.altColumn}"`);
  }

  /** Строки со значением, чей слот версии `target` пуст либо посчитан НЕ ею. */
  private outsideSlotWhere(def: EncryptedColumnDef, target: LoadedVersion): Prisma.Sql {
    const col = Prisma.raw(`"${def.column}"`);
    const slotCol = this.slotColumn(def, target);
    return Prisma.sql`${this.discriminatorWhere(def)} AND ${col} IS NOT NULL AND (${slotCol} IS NULL OR ${slotCol} NOT LIKE ${`sa6b:1:${target.kid}:%`})`;
  }

  private async countOutsideSlot(target: LoadedVersion): Promise<number> {
    let n = 0;
    for (const def of this.fields.all()) {
      if (!def.blindIndex) continue;
      const rows = await this.db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM ${qualifiedTable(def)} WHERE ${this.outsideSlotWhere(def, target)}`;
      n += Number(rows[0]?.n ?? 0);
    }
    return n;
  }

  private async fillBlindIndexSlot(target: LoadedVersion, deadline: number): Promise<{ filled: number; unavailable: number; conflicts: number; timedOut: boolean }> {
    const out = { filled: 0, unavailable: 0, conflicts: 0, timedOut: false };
    for (const def of this.fields.all()) {
      if (!def.blindIndex) continue;
      const bi = def.blindIndex;
      const table = qualifiedTable(def);
      const col = Prisma.raw(`"${def.column}"`);
      const slotCol = this.slotColumn(def, target);
      const idCol = Prisma.raw(`"${def.idColumn}"`);
      const scopeCol = def.scopeColumn ? Prisma.raw(`"${def.scopeColumn}"`) : null;
      const ids = await this.idCursor(def);
      let cursor = ids.start;
      for (;;) {
        if (Date.now() > deadline) return { ...out, timedOut: true };
        const rows = await this.db.$queryRaw<Array<{ id: string; value: string; owner: string | null }>>`
          SELECT ${idCol}::text AS id, ${col} AS value, ${scopeCol ? Prisma.sql`${scopeCol}::text` : Prisma.sql`NULL`} AS owner FROM ${table}
          WHERE ${this.outsideSlotWhere(def, target)} AND ${ids.gt(cursor)}
          ORDER BY ${ids.order} LIMIT ${KEYS_LIMITS.rewrapBatch}`;
        if (!rows.length) break;
        for (const row of rows) {
          const scope: KeyScopeRef = def.scope === 'platform' ? { type: 'platform' } : { type: def.scope, id: row.owner ?? '' };
          let plain: string | null = null;
          if (this.envelope.isEnvelope(row.value)) {
            if (scope.type === 'platform' || scope.id) {
              const ctx = { entity: def.entity, field: def.field, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
              const dec = await this.envelope.tryDecrypt(scope, ctx, row.value);
              if (dec.ok) plain = dec.value;
            }
          } else if (def.literal?.(row.value)) {
            plain = row.value; // служебная заглушка лежит без конверта
          }
          if (plain === null) {
            out.unavailable++;
            continue;
          }
          const next = this.envelope.blindIndexWith(target, bi.name, bi.normalize(plain));
          try {
            // Только если значение не сменилось с момента чтения: иначе индекс СТАРОГО номера лёг бы поверх нового
            await this.db.$executeRaw`UPDATE ${table} SET ${slotCol} = ${next} WHERE ${ids.eq(row.id)} AND ${col} = ${row.value}`;
            out.filled++;
          } catch (err) {
            // Уникум слота: такое значение уже занято другой строкой (дубль, возникший, пока чей-то KEK
            // был заморожен) — автоматически не решается, строка остаётся без индекса, разбирает человек
            if (!/23505|unique/i.test((err as Error).message)) throw err;
            out.conflicts++;
            this.logger.warn(`reindex ${def.table}.${bi.name} ${row.id}: the blind index value is already taken by another row`);
          }
        }
        cursor = rows[rows.length - 1]!.id;
        if (rows.length < KEYS_LIMITS.rewrapBatch) break;
      }
    }
    return out;
  }

  /** Прежняя версия после переключения: на вывод, её слот-колонка — в NULL (свободна под следующую смену). */
  async blindIndexRetire(payload: Record<string, unknown>): Promise<void> {
    const kid = typeof payload.kid === 'string' ? payload.kid : null;
    if (!kid) throw new JobDiscardError('keys.blindindex.retire: kid missing');
    const key = await this.store.getKey(PLATFORM_SCOPE, 'mac', BLIND_INDEX_KEY);
    const old = key?.versions.find((v) => v.kid === kid);
    const primary = key?.versions.find((v) => v.kid === key.primaryKid);
    // Никогда не трогаем primary и его слот (смена могла откатиться)
    if (!key || !old || !primary || old.kid === primary.kid || slotOf(old) === slotOf(primary)) return;
    if (old.state === 'active' || old.state === 'disabled' || old.state === 'pending') {
      await this.store.scheduleDestroy(kid, new Date(Date.now() + KEYS_LIMITS.destroyDelayDays * 86_400_000), { actorKind: 'system', reason: 'blind index switched to the next version' });
    }
    const deadline = Date.now() + KEYS_LIMITS.heavyJobBudgetMs;
    let cleared = 0;
    for (const def of this.fields.all()) {
      if (!def.blindIndex) continue;
      const table = qualifiedTable(def);
      const idCol = Prisma.raw(`"${def.idColumn}"`);
      const slotCol = this.slotColumn(def, old);
      for (;;) {
        if (Date.now() > deadline) {
          await this.jobs.enqueue(null, { type: KEYS_JOBS.blindIndexRetire, payload: { kid }, uniqueKey: `bi-retire:${kid}:cont:${Date.now()}` });
          return;
        }
        // Строго значения ВЫВОДИМОЙ версии: слот может уже заполняться следующей сменой
        const n = await this.db.$executeRaw`
          UPDATE ${table} SET ${slotCol} = NULL
          WHERE ${idCol} IN (SELECT ${idCol} FROM ${table} WHERE ${slotCol} LIKE ${`sa6b:1:${kid}:%`} LIMIT ${KEYS_LIMITS.slotCleanupBatch})`;
        cleared += n;
        if (n < KEYS_LIMITS.slotCleanupBatch) break;
      }
    }
    this.logger.log(`blind index version ${kid} retired: slot ${slotOf(old)} cleared (${cleared} values)`);
  }

  // ------------------------------------------------------------
  // Ротация корня: окно двух корней, перешивка порциями
  // ------------------------------------------------------------

  /** Перекличка: какие корни держит этот инстанс (перед ротацией корня сверяются ВСЕ живые инстансы). */
  @Cron(CronExpression.EVERY_MINUTE)
  async announce(): Promise<void> {
    try {
      await this.redis.getClient().hset(KEYS_REDIS.instances, this.instanceId, JSON.stringify({ roots: this.store.knownRootKids(), at: Date.now() }));
    } catch {
      /* best-effort: без Redis команда ротации корня откажет (fail-closed) */
    }
  }

  /**
   * Каждый живой инстанс обязан держать следующий корень: иначе версии, перешитые под него,
   * этот инстанс не откроет. Нет Redis или кто-то без корня — отказ (fail-closed).
   */
  async assertFleetHoldsRoot(rootKid: string): Promise<void> {
    await this.announce();
    const missing: string[] = [];
    try {
      const client = this.redis.getClient();
      const all = await client.hgetall(KEYS_REDIS.instances);
      const now = Date.now();
      for (const [id, raw] of Object.entries(all)) {
        let entry: { roots?: string[]; at?: number } = {};
        try {
          entry = JSON.parse(raw) as { roots?: string[]; at?: number };
        } catch {
          /* битая запись — как погашенный инстанс */
        }
        if (!entry.at || now - entry.at > KEYS_LIMITS.instanceStaleSec * 1000) {
          await client.hdel(KEYS_REDIS.instances, id);
          continue;
        }
        if (!entry.roots?.includes(rootKid)) missing.push(id);
      }
      if (!Object.keys(all).length) missing.push('no instances announced');
    } catch (err) {
      throw badRequest('keys.root_fleet_not_ready', { count: 1 }, { code: KEYS_ERROR_CODES.rootFleetNotReady, detail: (err as Error).message });
    }
    if (missing.length) throw badRequest('keys.root_fleet_not_ready', { count: missing.length }, { code: KEYS_ERROR_CODES.rootFleetNotReady, instances: missing.slice(0, 20) });
  }

  /** Перешивка под следующий корень порциями; не успел за бюджет — продолжение отдельным джобом. */
  async rootRewrap(): Promise<void> {
    const next = this.store.provider.nextRootKid;
    // Воркер без следующего корня джоб НЕ гасит: его возьмёт инстанс, у которого корень есть
    if (!next) throw new Error('keys.root.rewrap: this instance has no KEYS_ROOT_KEY_FILE_NEXT — the job is left for an instance that holds the next root');
    const deadline = Date.now() + KEYS_LIMITS.heavyJobBudgetMs;
    let total = 0;
    for (;;) {
      const n = await this.store.rewrapRootBatch(KEYS_LIMITS.rootRewrapBatch);
      total += n;
      if (n === 0) break;
      if (Date.now() > deadline) {
        await this.jobs.enqueue(null, { type: KEYS_JOBS.rootRewrap, payload: {}, uniqueKey: `root:${next}:cont:${Date.now()}` });
        this.logger.log(`root rewrap: ${total} versions in this pass, continuing in the next job`);
        return;
      }
    }
    await this.store.bumpEpoch();
    const st = await this.store.rootRotationStatus();
    if (st.underCurrent > 0) throw new Error(`root rewrap: ${st.underCurrent} version(s) still under the current root — the job retries`);
    await this.audit.log(null, { actorKind: 'system', subjectType: 'root', subjectId: next, subjectName: `root ${st.rootKid} → ${next}`, action: KEY_AUDIT_ACTIONS.rootRotated, details: { versions: total, underNext: st.underNext } });
    this.logger.warn(`root rotation finished: every key version is under the next root ${next}. Now set KEYS_ROOT_KEY_FILE to the new file, remove KEYS_ROOT_KEY_FILE_NEXT and restart every instance; destroy the old file after that.`);
  }

  /** Ротация начата, а под текущим корнем остались версии (рестарт посреди перешивки, версия-опоздавшая) — доперешить. */
  async resumeRootRewrap(): Promise<void> {
    const next = this.store.provider.nextRootKid;
    if (!next || !(await this.store.rootRotationStarted())) return;
    const st = await this.store.rootRotationStatus();
    if (st.underCurrent > 0) await this.jobs.enqueue(null, { type: KEYS_JOBS.rootRewrap, payload: {}, uniqueKey: `root:${next}` });
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
      await this.resumeRootRewrap();
      // Починка рабочего слота слепого индекса (строки размороженных скоупов) — no-op, когда чинить нечего
      await this.jobs.enqueue(null, { type: KEYS_JOBS.reindex, payload: {}, uniqueKey: `reindex:daily:${new Date().toISOString().slice(0, 10)}` });
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

  /**
   * KEK, чья PRIMARY-версия старше `kekRotationDays` → новая active-версия + джоб перешивки.
   * Выборка — по primary (а не «есть старая active-версия»): версии, ждущие вывода после
   * прошлой ротации, иначе занимали бы окно выборки вечно, и до остальных ключей очередь не
   * дошла бы. Старейшие — первыми, до `kekRotationsPerRun` за прогон.
   */
  async rotateAgedKeks(): Promise<number> {
    const cutoff = new Date(Date.now() - KEYS_LIMITS.kekRotationDays * 86_400_000);
    const aged = await this.db.$queryRaw<Array<{ scope: string }>>`
      SELECT k."scope" AS scope FROM "crypto_keys" k
      JOIN "crypto_key_versions" v ON v."id" = k."primary_version_id"
      WHERE k."purpose" = 'kek' AND v."state" = 'active' AND v."activated_at" < ${utcTs(cutoff)}
      ORDER BY v."activated_at" ASC LIMIT ${KEYS_LIMITS.kekRotationsPerRun}`;
    let n = 0;
    for (const key of aged) {
      try {
        await this.rotateKek(key.scope, { reason: 'age' });
        n++;
      } catch (err) {
        this.logger.warn(`kek rotation ${key.scope}: ${(err as Error).message}`);
      }
    }
    return n;
  }

  /**
   * Ротация KEK скоупа: новая primary + фоновая перешивка. Джоб ставится В ТОЙ ЖЕ транзакции,
   * что и версия, и стартует после `rewrapDelaySec` — когда кэш старого primary протух на всех
   * инстансах (запись старой версией после прохода перешивки осталась бы под ней).
   */
  async rotateKek(scope: string, actor: { actorId?: string | null; reason?: string | null }): Promise<string> {
    const key = await this.store.ensureKey(scope, 'kek', KEK_NAME);
    return this.store.createVersion(key.id, 'active', { actorId: actor.actorId ?? null, actorKind: actor.actorId ? 'platform' : 'system', reason: actor.reason ?? null }, async (tx, kid) => {
      await this.jobs.enqueue(tx, { type: KEYS_JOBS.rewrap, payload: { scope }, uniqueKey: `rewrap:${scope}:${kid}`, runAt: new Date(Date.now() + KEYS_LIMITS.rewrapDelaySec * 1000) });
    });
  }

  private scopeRef(scope: string): KeyScopeRef | null {
    if (scope === PLATFORM_SCOPE) return { type: 'platform' };
    if (scope.startsWith('workspace:')) return { type: 'workspace', id: scope.slice('workspace:'.length) };
    if (scope.startsWith('user:')) return { type: 'user', id: scope.slice('user:'.length) };
    return null;
  }
}
