import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { KEYS_LIMITS } from '@superapp/shared';
import { WorkspaceContextService } from '../../../shared/context/workspace-context.service';
import { DatabaseService } from '../../../shared/database/database.service';
import { MonthlyPartitions } from '../../../shared/database/monthly-partitions';
import { piiHooks, type PiiAccessEntry, type PiiFieldDef, type PiiHooks, type PiiModelDef, type PiiScopeRef } from '../../../shared/database/pii-hooks';
import { RedisService } from '../../../shared/redis/redis.service';
import { JobDiscardError, JobsRegistry } from '../../jobs/jobs.registry';
import { JobsService } from '../../jobs/jobs.service';
import { KEYS_JOBS, KEYS_QUEUE } from '../keys.constants';
import { keysEnv } from '../keys.env';
import { KeysEnvelopeService } from '../keys.envelope.service';
import { KeysStoreService } from '../keys.store.service';
import { PII_MODELS, PII_MODEL_MAP, PII_PLAINTEXT_PRESENT } from './keys.pii.registry';

/** Ретеншн журнала чтений ПДн, дней (как у журнала чтений кабинета) */
const ACCESS_LOG_RETENTION_DAYS = 365;
const FLUSH_MS = 2000;
const FLUSH_MAX = 200;

interface RelationInfo {
  model: string;
  isList: boolean;
}

/**
 * ПДн-слой движка ключей: ставит хуки прозрачного Prisma-расширения (`pii-extension.ts`),
 * ведёт бэкфилл `_enc`/`_bi` для строк прошлой эпохи, пишет журнал чтений чувствительных
 * полей (`pii_access_log`, приказ 179/НҚ), отдаёт статус миграции. Режим чтения —
 * `KEYS_PII_READ_MODE` (`legacy` | `encrypted`), переключается одним деплоем после
 * того, как `status()` показывает 0 небэкфилленных строк.
 */
@Injectable()
export class KeysPiiService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KeysPiiService.name);
  private readonly relations = new Map<string, Map<string, RelationInfo>>();
  private readonly buffer: Array<PiiAccessEntry & { actorId: string | null; actorKind: string; workspaceId: string | null }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Месячные партиции `pii_access_log` (ретеншн — сброс партиции целиком) */
  readonly partitions: MonthlyPartitions;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly envelope: KeysEnvelopeService,
    private readonly store: KeysStoreService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
  ) {
    this.partitions = new MonthlyPartitions(db, { table: 'pii_access_log', column: 'occurred_at', retentionDays: ACCESS_LOG_RETENTION_DAYS });
    for (const m of Prisma.dmmf.datamodel.models) {
      const rels = new Map<string, RelationInfo>();
      for (const f of m.fields) if (f.kind === 'object') rels.set(f.name, { model: f.type, isList: f.isList });
      this.relations.set(m.name, rels);
    }
  }

  onModuleInit(): void {
    this.registry.register(KEYS_JOBS.piiBackfill, async () => void (await this.backfill()), { queue: KEYS_QUEUE, maxAttempts: 10, leaseMs: 60 * 60_000, queueConcurrency: 1 });
  }

  /** Хуки — после старта всех модулей (keystore готов); до этого расширение — passthrough. */
  onApplicationBootstrap(): void {
    // Партиции журнала чтений на месяцы вперёд — best-effort, под замком (инстансов много)
    void this.redis
      .withLock('cron:keys:pii-partitions', 60_000, () => this.partitions.ensureAhead())
      .catch((err: unknown) => this.logger.warn(`pii_access_log partitions on boot: ${err instanceof Error ? err.message : String(err)}`));
    // Каждая модель реестра обязана существовать в схеме, а каждое поле `_enc`/`_bi` — быть колонкой:
    // иначе запись падала бы на первом же пользователе с непонятной ошибкой Prisma
    for (const def of PII_MODELS) {
      const m = Prisma.dmmf.datamodel.models.find((x) => x.name === def.model);
      if (!m) throw new Error(`pii registry: model ${def.model} is not in the Prisma schema`);
      const names = new Set(m.fields.map((f) => f.name));
      for (const f of def.fields) {
        for (const col of [f.name, f.enc, f.bi]) if (col && !names.has(col)) throw new Error(`pii registry: ${def.model}.${col} is not a schema field`);
      }
    }
    const hooks: PiiHooks = {
      readMode: () => keysEnv().piiReadMode,
      // Открытые колонки живут до отдельной миграции дропа (docs/keys_pii.md): тогда → false
      plaintextPresent: () => PII_PLAINTEXT_PRESENT,
      models: PII_MODEL_MAP,
      encrypt: (scope, ctx, plain) => this.envelope.encrypt(scope, ctx, plain),
      decrypt: async (scope, ctx, stored) => {
        const r = await this.envelope.tryDecrypt(scope, ctx, stored);
        return r.ok ? r.value : null;
      },
      prefetch: (kids) => this.store.prefetch(kids),
      kekKidOf: (stored) => this.envelope.kekKidOf(stored),
      blindIndex: (index, normalized) => this.envelope.blindIndex(index, normalized),
      logAccess: (entry) => this.logAccess(entry),
      relation: (model, field) => this.relations.get(model)?.get(field) ?? null,
      fetchScopeRow: (model, where) => this.fetchScopeRow(model, where),
      newId: () => randomUUID(),
    };
    piiHooks.current = hooks;
    // Бэкфилл строк прошлой эпохи — джоб на каждом старте (идемпотентный)
    void this.jobs
      .enqueue(null, { type: KEYS_JOBS.piiBackfill, payload: {}, uniqueKey: 'boot', runAt: new Date(Date.now() + 30_000) })
      .catch((err) => this.logger.warn(`pii backfill enqueue failed: ${(err as Error).message}`));
    this.logger.log(`pii layer ready: ${PII_MODELS.length} models, read mode ${keysEnv().piiReadMode}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private async fetchScopeRow(model: string, where: unknown): Promise<Record<string, unknown> | null> {
    const def = PII_MODEL_MAP.get(model);
    if (!def || !where || typeof where !== 'object') return null;
    const select: Record<string, boolean> = { id: true };
    for (const f of def.scopeFields) select[f] = true;
    const delegate = (this.db as unknown as Record<string, { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> }>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    if (!delegate) return null;
    try {
      // Где-поле ПДн внутри where уже переписано на _bi расширением до этого вызова? Нет: мы
      // внутри транзформации записи, where нетронут — читаем тем же клиентом (расширение
      // само перепишет where в режиме encrypted).
      return await delegate.findUnique({ where, select });
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------
  // Журнал чтений чувствительных полей (батч, вне транзакции)
  // ------------------------------------------------------------

  private logAccess(entry: PiiAccessEntry): void {
    const store = this.ctx.get();
    this.buffer.push({
      ...entry,
      actorId: store?.userId ?? null,
      actorKind: store?.userId ? 'user' : 'system',
      workspaceId: store?.activeWorkspaceId ?? null,
    });
    if (this.buffer.length >= FLUSH_MAX) void this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const data = batch.map((b) => ({ actorId: b.actorId, actorKind: b.actorKind, workspaceId: b.workspaceId, entity: b.entity, fields: b.fields, count: b.count, sampleIds: b.ids }));
    try {
      try {
        await this.db.piiAccessLog.createMany({ data });
      } catch (err) {
        // Месяц без партиции (крон не успел) — завести и повторить один раз
        if (!MonthlyPartitions.isMissingPartition(err)) throw err;
        await this.partitions.ensureFor(new Date());
        await this.db.piiAccessLog.createMany({ data });
      }
    } catch (err) {
      this.logger.warn(`pii access log write failed (${batch.length} rows): ${(err as Error).message}`);
    }
  }

  /** Страховка на окне dual-write: строки, записанные мимо слоя (скрипты, миграции), получают `_enc`/`_bi` в течение часа. */
  @Cron(CronExpression.EVERY_HOUR)
  async hourlyBackfill(): Promise<void> {
    await this.redis.withLock('cron:keys:pii-backfill', 600, async () => {
      await this.jobs.enqueue(null, { type: KEYS_JOBS.piiBackfill, payload: {}, uniqueKey: `hourly:${new Date().toISOString().slice(0, 13)}` });
    });
  }

  /** Ретеншн журнала чтений ПДн — сброс месячных партиций старше `ACCESS_LOG_RETENTION_DAYS` (и партиции вперёд). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async retention(): Promise<void> {
    await this.redis.withLock('cron:keys:pii-retention', 300, async () => {
      await this.partitions.ensureAhead();
      const dropped = await this.partitions.dropExpired();
      if (dropped.length) this.logger.log(`pii access log retention: dropped ${dropped.join(', ')}`);
    });
  }

  // ------------------------------------------------------------
  // Бэкфилл: строки с открытым текстом без `_enc` → envelope + `_bi` (сырым SQL, updatedAt не трогается)
  // ------------------------------------------------------------

  private table(model: string): { table: string; col: (field: string) => string } {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
    if (!m) throw new JobDiscardError(`pii backfill: unknown model ${model}`);
    const byName = new Map(m.fields.map((f) => [f.name, f.dbName ?? f.name]));
    return { table: m.dbName ?? m.name, col: (field) => byName.get(field) ?? field };
  }

  async backfill(): Promise<number> {
    let total = 0;
    for (const def of PII_MODELS) total += await this.backfillModel(def);
    if (total) this.logger.log(`pii backfill: ${total} field values encrypted`);
    return total;
  }

  private async backfillModel(def: PiiModelDef): Promise<number> {
    const { table, col } = this.table(def.model);
    const t = Prisma.raw(`"${table}"`);
    let total = 0;
    for (const f of def.fields) {
      const plain = Prisma.raw(`"${col(f.name)}"`);
      const enc = Prisma.raw(`"${col(f.enc)}"`);
      const bi = f.bi ? Prisma.raw(`"${col(f.bi)}"`) : null;
      const scopeCols = def.scopeFields.map((s) => Prisma.raw(`"${col(s)}" AS "${s}"`));
      const scopeSelect = scopeCols.length ? Prisma.sql`, ${Prisma.join(scopeCols)}` : Prisma.empty;
      let cursor = '';
      for (;;) {
        const rows = await this.db.$queryRaw<Array<Record<string, unknown> & { id: string; plain: unknown }>>`
          SELECT "id"::text AS id, ${plain} AS plain${scopeSelect} FROM ${t}
          WHERE ${plain} IS NOT NULL AND ${enc} IS NULL AND "id"::text > ${cursor}
          ORDER BY "id"::text LIMIT ${KEYS_LIMITS.rewrapBatch}`;
        if (!rows.length) break;
        for (const row of rows) {
          const scope = def.scope(row);
          if (!scope) continue;
          const value = this.normalize(f, row.plain);
          if (value === null) continue;
          const ctx = { entity: def.entity, field: f.name, ownerType: scope.type, ownerId: scope.type === 'platform' ? 'platform' : scope.id };
          let encValue: string;
          try {
            encValue = await this.envelope.encrypt(scope, ctx, value);
          } catch (err) {
            this.logger.warn(`pii backfill ${table}.${col(f.name)} ${row.id}: ${(err as Error).message}`);
            continue;
          }
          const biValue = f.bi && f.index ? await this.envelope.blindIndex(f.index, f.normalize ? f.normalize(value) : value) : null;
          if (bi) {
            await this.db.$executeRaw`UPDATE ${t} SET ${enc} = ${encValue}, ${bi} = ${biValue} WHERE "id"::text = ${row.id} AND ${enc} IS NULL`;
          } else {
            await this.db.$executeRaw`UPDATE ${t} SET ${enc} = ${encValue} WHERE "id"::text = ${row.id} AND ${enc} IS NULL`;
          }
          total++;
        }
        cursor = rows[rows.length - 1]!.id;
        if (rows.length < KEYS_LIMITS.rewrapBatch) break;
      }
    }
    return total;
  }

  private normalize(f: PiiFieldDef, v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (f.kind === 'date') {
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    return String(v);
  }

  /** Сколько строк ещё без `_enc` — по моделям (0 везде = можно включать `encrypted`). */
  async status(): Promise<{ readMode: string; pending: Array<{ model: string; field: string; rows: number }>; total: number }> {
    const pending: Array<{ model: string; field: string; rows: number }> = [];
    let total = 0;
    for (const def of PII_MODELS) {
      const { table, col } = this.table(def.model);
      const t = Prisma.raw(`"${table}"`);
      for (const f of def.fields) {
        const plain = Prisma.raw(`"${col(f.name)}"`);
        const enc = Prisma.raw(`"${col(f.enc)}"`);
        const rows = await this.db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM ${t} WHERE ${plain} IS NOT NULL AND ${enc} IS NULL`;
        const n = Number(rows[0]?.n ?? 0);
        if (n) pending.push({ model: def.model, field: f.name, rows: n });
        total += n;
      }
    }
    return { readMode: keysEnv().piiReadMode, pending, total };
  }

  /** Скоуп записи по модели (для дев-полигона и учений). */
  scopeOf(model: string, row: Record<string, unknown>): PiiScopeRef | null {
    return PII_MODEL_MAP.get(model)?.scope(row) ?? null;
  }
}
