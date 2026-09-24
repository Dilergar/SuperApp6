import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_QUEUE,
  lifecycleLooseFkEdges,
  lifecyclePolicy,
  type LifecycleLooseFkEdge,
  type LifecyclePolicy,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { LifecycleMetrics } from './lifecycle.metrics';
import { holdFreeSql, lifecycleTableOf, lockHoldsShared } from './lifecycle.sql';

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Ребёнок ребра глазами SQL: таблица, колонка-ссылка, её тип, политика (для заморозок). */
interface ChildTarget {
  edge: LifecycleLooseFkEdge;
  policy: LifecyclePolicy;
  table: Prisma.Sql;
  tableName: string;
  column: string;
  /** Проверять заморозку (у модели с holdAware) */
  holdAware: boolean;
}

interface DeletedRow {
  id: bigint;
  deleted_at: Date;
  table_name: string;
  row_id: string;
}

/**
 * Loose FK (GitLab): строки без внешнего ключа на родителя (полиморфные ссылки, журналы,
 * производные копии) добираются ПОСЛЕ удаления родителя. Триггер `lifecycle_track_delete`
 * на таблице родителя пишет id удалённых строк в `lifecycle_deleted_rows` (ловит и каскад
 * FK, и сырой DELETE — путь удаления не важен), этот воркер по рёбрам `async_delete` /
 * `async_nullify` реестра удаляет или обнуляет детей пачками.
 *
 * Строка учёта помечается обработанной только когда ВСЕ её дети ушли; ребёнок под заморозкой
 * остаётся, строка учёта откладывается на сутки (`retry_at`) — снятая заморозка догонится.
 * Необработанная строка держит свою дневную партицию от сброса (`require_processed`).
 */
@Injectable()
export class LifecycleLooseFk implements OnModuleInit {
  private readonly logger = new Logger(LifecycleLooseFk.name);
  private readonly edgesByTable = new Map<string, ChildTarget[]>();
  private readonly columnTypes = new Map<string, string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly metrics: LifecycleMetrics,
  ) {
    for (const edge of lifecycleLooseFkEdges()) {
      const parent = lifecyclePolicy(edge.parent);
      const parentTable = parent ? lifecycleTableOf(parent) : null;
      const child = lifecyclePolicy(edge.child);
      if (!parentTable || !child) continue;
      const target = this.childTarget(edge, child);
      if (!target) continue;
      const key = parentTable.name.split('.')[1]!;
      if (!this.edgesByTable.has(key)) this.edgesByTable.set(key, []);
      this.edgesByTable.get(key)!.push(target);
    }
  }

  onModuleInit(): void {
    this.jobsRegistry.register(LIFECYCLE_JOBS.looseFk, () => this.handle(), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 2,
      leaseMs: LIFECYCLE_LIMITS.looseFkBudgetMs + 120_000,
      maxAttempts: 3,
    });
  }

  /** Таблицы родителей, у которых должен стоять триггер учёта (сверка сьютом с живой БД). */
  trackedTables(): string[] {
    return [...this.edgesByTable.keys()].sort();
  }

  /** Поставить проход (крон каждые 5 минут); живой проход уже есть — no-op. */
  async schedule(): Promise<void> {
    await this.jobs.enqueue(null, { type: LIFECYCLE_JOBS.looseFk, payload: {}, uniqueKey: 'loose-fk' });
  }

  async backlog(): Promise<number> {
    const [r] = await this.db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "lifecycle_deleted_rows" WHERE processed_at IS NULL`;
    const n = Number(r?.n ?? 0);
    this.metrics.looseFkBacklog(n);
    return n;
  }

  private async handle(): Promise<void> {
    const res = await this.process(LIFECYCLE_LIMITS.looseFkBudgetMs);
    if (res.more) throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'loose FK backlog, continuing');
  }

  /** Один проход в пределах бюджета. `more` — осталось необработанное. */
  async process(budgetMs: number): Promise<{ parents: number; children: number; deferred: number; more: boolean }> {
    const deadline = Date.now() + budgetMs;
    let parents = 0;
    let children = 0;
    let deferred = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<DeletedRow[]>`
        SELECT id, deleted_at, table_name, row_id::text AS row_id
          FROM "lifecycle_deleted_rows"
         WHERE processed_at IS NULL AND (retry_at IS NULL OR retry_at <= clock_timestamp())
         ORDER BY deleted_at, id
         LIMIT ${LIFECYCLE_LIMITS.looseFkBatch}`;
      if (!rows.length) return { parents, children, deferred, more: false };
      const byTable = new Map<string, DeletedRow[]>();
      for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
        byTable.get(r.table_name)!.push(r);
      }
      for (const [table, group] of byTable) {
        const ids = [...new Set(group.map((r) => r.row_id))];
        const held = new Set<string>();
        for (const target of this.edgesByTable.get(table) ?? []) {
          const res = await this.drain(target, ids, deadline);
          children += res.rows;
          if (!res.done) return { parents, children, deferred, more: true };
          for (const id of res.held) held.add(id);
        }
        const doneRows = group.filter((r) => !held.has(r.row_id));
        const heldRows = group.filter((r) => held.has(r.row_id));
        await this.mark(doneRows, 'processed');
        await this.mark(heldRows, 'retry');
        parents += doneRows.length;
        deferred += heldRows.length;
        this.metrics.looseFkProcessed(table, doneRows.length);
      }
      if (Date.now() > deadline) return { parents, children, deferred, more: true };
    }
  }

  /** Дети одного ребра для пачки родителей; `held` — родители, у которых остались дети под заморозкой. */
  private async drain(target: ChildTarget, ids: string[], deadline: number): Promise<{ rows: number; done: boolean; held: string[] }> {
    const type = await this.columnType(target.tableName, target.column);
    const col = Prisma.raw(`t."${target.column}"`);
    const idList = Prisma.sql`${ids}::text[]::${Prisma.raw(type)}[]`;
    const hold = target.holdAware ? this.holdFree(target) : Prisma.sql`TRUE`;
    const limit = LIFECYCLE_LIMITS.looseFkChildBatch;
    let rows = 0;
    for (;;) {
      if (Date.now() > deadline) return { rows, done: false, held: [] };
      const n = await this.db.$transaction(async (tx) => {
        await lockHoldsShared(tx);
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LIFECYCLE_LIMITS.batchLockTimeoutMs}ms`}, true)`;
        if (target.edge.kind === 'async_nullify') {
          return tx.$executeRaw`
            UPDATE ${target.table} t SET "${Prisma.raw(target.column)}" = NULL
              FROM (SELECT t.tableoid AS toid, t.ctid AS tid FROM ${target.table} t WHERE ${col} = ANY(${idList}) AND ${hold} LIMIT ${limit}) d
             WHERE t.tableoid = d.toid AND t.ctid = d.tid`;
        }
        return tx.$executeRaw`
          DELETE FROM ${target.table} t
           USING (SELECT t.tableoid AS toid, t.ctid AS tid FROM ${target.table} t WHERE ${col} = ANY(${idList}) AND ${hold} LIMIT ${limit}) d
           WHERE t.tableoid = d.toid AND t.ctid = d.tid`;
      });
      rows += n;
      if (n < limit) break;
    }
    if (!target.holdAware) return { rows, done: true, held: [] };
    const left = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT ${col}::text AS id FROM ${target.table} t WHERE ${col} = ANY(${idList})`;
    return { rows, done: true, held: left.map((r) => r.id) };
  }

  private holdFree(target: ChildTarget): Prisma.Sql {
    const t = lifecycleTableOf(target.policy);
    return t ? holdFreeSql(target.policy, t) : Prisma.sql`TRUE`;
  }

  private async mark(rows: DeletedRow[], how: 'processed' | 'retry'): Promise<void> {
    if (!rows.length) return;
    const ids = rows.map((r) => r.id.toString());
    const min = new Date(Math.min(...rows.map((r) => r.deleted_at.getTime())));
    const max = new Date(Math.max(...rows.map((r) => r.deleted_at.getTime())));
    if (how === 'processed') {
      await this.db.$executeRaw`
        UPDATE "lifecycle_deleted_rows" SET processed_at = clock_timestamp()
         WHERE id = ANY(${ids}::bigint[]) AND deleted_at BETWEEN ${min}::timestamptz AND ${max}::timestamptz`;
    } else {
      await this.db.$executeRaw`
        UPDATE "lifecycle_deleted_rows" SET retry_at = clock_timestamp() + make_interval(secs => ${LIFECYCLE_LIMITS.looseFkHeldRetryMs / 1000})
         WHERE id = ANY(${ids}::bigint[]) AND deleted_at BETWEEN ${min}::timestamptz AND ${max}::timestamptz`;
    }
  }

  private childTarget(edge: LifecycleLooseFkEdge, child: LifecyclePolicy): ChildTarget | null {
    if (child.store.kind === 'model') {
      const t = lifecycleTableOf(child);
      const f = t?.fields.get(edge.via);
      if (!t || !f) {
        this.logger.error(`loose FK ${edge.parent} → ${edge.child}: no column for "${edge.via}" — edge skipped`);
        return null;
      }
      return { edge, policy: child, table: t.ident, tableName: t.name, column: f.column, holdAware: child.holdAware };
    }
    if (child.store.kind === 'table') {
      const [schema, table] = child.store.table.split('.');
      if (!schema || !table || !IDENT.test(schema) || !IDENT.test(table) || !IDENT.test(edge.via)) return null;
      return { edge, policy: child, table: Prisma.raw(`"${schema}"."${table}"`), tableName: `${schema}.${table}`, column: edge.via, holdAware: false };
    }
    return null;
  }

  /** Тип колонки-ссылки из каталога (uuid / text): сравнение без приведения колонки держит индекс. */
  private async columnType(table: string, column: string): Promise<string> {
    const key = `${table}.${column}`;
    const cached = this.columnTypes.get(key);
    if (cached) return cached;
    const [r] = await this.db.$queryRaw<Array<{ t: string | null }>>`
      SELECT format_type(a.atttypid, NULL) AS t FROM pg_attribute a WHERE a.attrelid = to_regclass(${table}) AND a.attname = ${column} AND NOT a.attisdropped`;
    const type = r?.t === 'uuid' ? 'uuid' : 'text';
    this.columnTypes.set(key, type);
    return type;
  }
}
