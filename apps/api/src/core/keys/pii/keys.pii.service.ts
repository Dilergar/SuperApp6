import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { KEYS_LIMITS } from '@superapp/shared';
import { WorkspaceContextService } from '../../../shared/context/workspace-context.service';
import { DatabaseService } from '../../../shared/database/database.service';
import { piiHooks, type PiiAccessEntry, type PiiFieldDef, type PiiHooks, type PiiModelDef, type PiiScopeRef } from '../../../shared/database/pii-hooks';
import { RedisService } from '../../../shared/redis/redis.service';
import { DI_TOKENS } from '../../../shared/di-tokens';
import type { AuditService } from '../../audit/audit.service';
import { JobDiscardError, JobsRegistry } from '../../jobs/jobs.registry';
import { JobsService } from '../../jobs/jobs.service';
import { KEYS_JOBS, KEYS_QUEUE } from '../keys.constants';
import { keysEnv } from '../keys.env';
import { KeysEnvelopeService } from '../keys.envelope.service';
import { KeysFieldRegistry } from '../keys.registry';
import { KeysStoreService } from '../keys.store.service';
import { PII_MODELS, PII_MODEL_MAP, PII_PLAINTEXT_PRESENT } from './keys.pii.registry';

/** Ретеншн журнала чтений ПДн, дней (как у журнала чтений кабинета) */

interface RelationInfo {
  model: string;
  isList: boolean;
}

/**
 * ПДн-слой движка ключей: ставит хуки прозрачного Prisma-расширения (`pii-extension.ts`),
 * ведёт бэкфилл `_enc`/`_bi` для строк прошлой эпохи, пишет журнал чтений чувствительных
 * полей (событие `pii.read` журнала безопасности, приказ 179/НҚ), отдаёт статус миграции. Режим чтения —
 * `KEYS_PII_READ_MODE` (`legacy` | `encrypted`), переключается одним деплоем после
 * того, как `status()` показывает 0 небэкфилленных строк.
 */
@Injectable()
export class KeysPiiService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(KeysPiiService.name);
  private readonly relations = new Map<string, Map<string, RelationInfo>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ctx: WorkspaceContextService,
    private readonly envelope: KeysEnvelopeService,
    private readonly store: KeysStoreService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly keyFields: KeysFieldRegistry,
    private readonly moduleRef: ModuleRef,
  ) {
    for (const m of Prisma.dmmf.datamodel.models) {
      const rels = new Map<string, RelationInfo>();
      for (const f of m.fields) if (f.kind === 'object') rels.set(f.name, { model: f.type, isList: f.isList });
      this.relations.set(m.name, rels);
    }
  }

  onModuleInit(): void {
    this.registry.register(KEYS_JOBS.piiBackfill, async () => void (await this.backfill()), { queue: KEYS_QUEUE, maxAttempts: 10, leaseMs: 60 * 60_000, queueConcurrency: 1 });
    this.registerEncryptedColumns();
  }

  /**
   * Каждая `_enc`-колонка ПДн — в реестре шифрованных колонок движка: по нему после ротации
   * KEK идёт перешивка (`keys.rewrap`), а после ротации mac-ключа — переиндексация
   * (`keys.reindex`). Колонка вне реестра осталась бы под старой версией KEK, а та после
   * перешивки выводится — телефон, e-mail и ИИН стали бы нечитаемыми. Декларация скоупа
   * (`keyScopes`) сверяется со `scope()` пробной строкой: расхождение роняет бут.
   */
  private registerEncryptedColumns(): void {
    for (const def of PII_MODELS) {
      const { table, col } = this.table(def.model);
      if (!def.keyScopes.length) throw new Error(`pii registry: ${def.model} declares no keyScopes`);
      for (const ks of def.keyScopes) {
        const probe: Record<string, unknown> = {};
        if (ks.type !== 'platform') {
          probe[ks.field] = 'probe';
          if (ks.discriminator) probe[ks.discriminator.field] = ks.discriminator.value;
        }
        const got = def.scope(probe);
        const same = got && got.type === ks.type && (ks.type === 'platform' || (got.type !== 'platform' && got.id === 'probe'));
        if (!same) throw new Error(`pii registry: ${def.model}.keyScopes (${ks.type}) disagrees with scope()`);
        for (const f of def.fields) {
          this.keyFields.register({
            table,
            idColumn: col('id'),
            column: col(f.enc),
            scope: ks.type,
            scopeColumn: ks.type === 'platform' ? undefined : col(ks.field),
            scopeDiscriminator: ks.type !== 'platform' && ks.discriminator ? { column: col(ks.discriminator.field), value: ks.discriminator.value } : undefined,
            entity: def.entity,
            field: f.name,
            literal: f.literal,
            blindIndex: f.bi && f.biAlt && f.index ? { column: col(f.bi), altColumn: col(f.biAlt), name: f.index, normalize: f.normalize ?? ((v: string) => v) } : undefined,
          });
        }
      }
    }
  }

  /** Хуки — после старта всех модулей (keystore готов); до этого расширение — passthrough. */
  onApplicationBootstrap(): void {
    // Каждая модель реестра обязана существовать в схеме, а каждое поле `_enc`/`_bi` — быть колонкой:
    // иначе запись падала бы на первом же пользователе с непонятной ошибкой Prisma
    for (const def of PII_MODELS) {
      const m = Prisma.dmmf.datamodel.models.find((x) => x.name === def.model);
      if (!m) throw new Error(`pii registry: model ${def.model} is not in the Prisma schema`);
      const names = new Set(m.fields.map((f) => f.name));
      for (const f of def.fields) {
        for (const col of [f.name, f.enc, f.bi, f.biAlt]) if (col && !names.has(col)) throw new Error(`pii registry: ${def.model}.${col} is not a schema field`);
        // Слепой индекс — всегда парой слотов: без второго смена ключа `blind_index` встала бы на этой колонке
        if (!!f.bi !== !!f.biAlt) throw new Error(`pii registry: ${def.model}.${f.name} must declare both blind index slots (bi + biAlt)`);
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
      blindIndexPlan: () => this.envelope.blindIndexPlan(),
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

  /**
   * Агрегат чтения на запрос — событие `pii.read` журнала безопасности (core/audit): батч
   * движка журнала, вне транзакции, best-effort с метрикой отказов. Организация видит чтения
   * ПДн своих сотрудников (активная организация запроса), платформа — все.
   * `AuditService` — лениво по `DI_TOKENS.AuditService` (журнал сам тянет keystore).
   */
  private logAccess(entry: PiiAccessEntry): void {
    const store = this.ctx.get();
    const audit = this.moduleRef.get<AuditService>(DI_TOKENS.AuditService, { strict: false });
    void audit
      .recordBatch(null, [
        {
          key: 'pii.read',
          workspaceId: store?.activeWorkspaceId ?? null,
          details: { entity: entry.entity, fields: entry.fields.slice(0, 32), count: entry.count, sampleIds: entry.ids.slice(0, 10) },
        },
      ])
      .catch((err: unknown) => this.logger.warn(`pii read audit failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Страховка на окне dual-write: строки, записанные мимо слоя (скрипты, миграции), получают `_enc`/`_bi` в течение часа. */
  @Cron(CronExpression.EVERY_HOUR)
  async hourlyBackfill(): Promise<void> {
    await this.redis.withLock('cron:keys:pii-backfill', 600, async () => {
      await this.jobs.enqueue(null, { type: KEYS_JOBS.piiBackfill, payload: {}, uniqueKey: `hourly:${new Date().toISOString().slice(0, 13)}` });
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
      const hasBi = !!(f.bi && f.biAlt && f.index);
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
            // Служебная заглушка (`deleted:` / `bot:`) — не ПДн: в `_enc` как есть, без KEK
            encValue = f.literal?.(value) ? value : await this.envelope.encrypt(scope, ctx, value);
          } catch (err) {
            this.logger.warn(`pii backfill ${table}.${col(f.name)} ${row.id}: ${(err as Error).message}`);
            continue;
          }
          if (hasBi) {
            // Те же слоты, что у живой записи: рабочий — primary-версией, второй — pending на окне смены ключа
            const plan = await this.envelope.blindIndexPlan();
            const norm = f.normalize ? f.normalize(value) : value;
            const cur = Prisma.raw(`"${col(plan.slot === 0 ? f.bi! : f.biAlt!)}"`);
            const other = Prisma.raw(`"${col(plan.slot === 0 ? f.biAlt! : f.bi!)}"`);
            await this.db.$executeRaw`UPDATE ${t} SET ${enc} = ${encValue}, ${cur} = ${plan.value(f.index!, norm)}, ${other} = ${plan.pendingValue(f.index!, norm)} WHERE "id"::text = ${row.id} AND ${enc} IS NULL`;
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
