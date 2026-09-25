import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  LIFECYCLE_EXPORT_PREFIX,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_POLICY_IDS,
  LIFECYCLE_QUEUE,
  lifecycleExportManifestPayload,
  lifecyclePolicy,
  type LifecycleExportManifest,
  type LifecycleRestoreArchiveDto,
  type LifecycleRestoreReportDto,
  type LifecycleRestoreTableReport,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { STORAGE_DRIVER, type StorageDriver } from '../files/storage/storage-driver';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import type { LifecycleCollectedPage } from './lifecycle.export.collector';
import type { LifecycleExportContext } from './lifecycle.export.registry';
import { LifecycleExportService, type LifecycleExportSource } from './lifecycle.export.service';
import { LifecycleErasureService } from './lifecycle.erasure.service';
import { LifecycleRuns } from './lifecycle.runs';
import { exportScopeSql, lifecycleTableOf, pkFieldOf, type LifecycleTable } from './lifecycle.sql';

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** Строк одной вставки импорта. */
const IMPORT_BATCH = 500;
/** Потолок запомненных отказов для повторной попытки в конце (строка, чей родитель пришёл позже). */
const RETRY_CAP = 5000;
/** Потолок id людей, собираемых для реплея стираний. */
const PEOPLE_CAP = 100_000;

interface ImportState {
  exportId: string;
  workspaceId: string;
  snapshotAt: string;
  order: number[];
  step: number;
  tables: Record<string, LifecycleRestoreTableReport>;
  retry: Array<{ entry: number; line: number }>;
  people: string[];
  missingBlobs: number;
  erasuresReplayed: number;
  phase: 'rows' | 'retry' | 'replay' | 'done';
}

/** Незарезервированные имена колонок таблицы в порядке, без генерируемых (их считает база). */
interface TableColumns {
  insert: string[];
}

function q(id: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(id)) throw new Error(`lifecycle restore: unsafe identifier "${id}"`);
  return `"${id}"`;
}

/**
 * Восстановление ОДНОЙ организации из бэкапа (Atlassian 2022: 14 дней без инструмента
 * восстановления арендатора; Salesforce Backup / Shopify Rewind) — два шага Кабинета, оба
 * через второго сотрудника:
 *
 * 1. `lifecycle.restore.extract` — строки организации по реестру (область стороны
 *    «организация» каждой модели) из кластера, поднятого на точку времени (PITR,
 *    `LIFECYCLE_RESTORE_SOURCE_URL`, роль только на чтение), КАК ЕСТЬ (`to_jsonb`: шифротекст
 *    ПДн остаётся шифротекстом) → архив восстановления в префиксе выгрузки, манифест подписан
 *    Ed25519 (аудитория `lifecycle`), sha256 каждого куска.
 * 2. `lifecycle.restore.import` — подпись и хэши сверяются; строки вставляются в порядке
 *    внешних ключей живой базы (родители раньше детей), `ON CONFLICT DO NOTHING` — id
 *    сохраняются, существующее не трогается (конфликт = пропуск). Перед вставкой каждая
 *    пачка НЕЗАВИСИМО проверяется на значениях: все строки — этой организации (иначе стоп).
 *    Затем реплей стираний: люди из вернувшихся строк, стёртые после снимка, стираются заново.
 *
 * Организацию, чьё стирание уже прошло горячую фазу, восстановить нельзя: стирание побеждает.
 */
@Injectable()
export class LifecycleRestoreService implements LifecycleExportSource, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LifecycleRestoreService.name);
  private client: PrismaClient | null = null;
  private readonly columns = new Map<string, TableColumns>();

  constructor(
    private readonly db: DatabaseService,
    private readonly exports: LifecycleExportService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly jobs: JobsService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    private readonly signing: KeysSigningService,
    private readonly erasure: LifecycleErasureService,
    private readonly runs: LifecycleRuns,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.exports.setRestoreSource(this);
    this.jobsRegistry.register(LIFECYCLE_JOBS.restore, (payload) => this.handle(String((payload as Row).runId ?? '')), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 1,
      leaseMs: LIFECYCLE_LIMITS.jobBudgetMs + 120_000,
      maxAttempts: 25,
      onDiscard: async (payload, info) => {
        const runId = String((payload as Row).runId ?? '');
        if (runId) await this.runs.finish(runId, 'failed', { report: { error: info.error.slice(0, 500) } });
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }

  // ============================================================
  // Источник (извлечение)
  // ============================================================

  /** Настроен ли источник: в production без него команды отказывают (основная база — не бэкап). */
  sourceConfigured(): boolean {
    return !!process.env.LIFECYCLE_RESTORE_SOURCE_URL || isDevEnv();
  }

  assertSource(): void {
    if (!this.sourceConfigured()) throw badRequest('lifecycle.restoreSourceMissing');
  }

  private source(): PrismaClient {
    const url = process.env.LIFECYCLE_RESTORE_SOURCE_URL;
    if (!url) return this.db;
    if (!this.client) {
      this.client = new PrismaClient({ datasourceUrl: url, log: ['error'] });
      this.logger.log('tenant restore reads the PITR cluster (LIFECYCLE_RESTORE_SOURCE_URL)');
    }
    return this.client;
  }

  /** Модели, чьи строки организация может иметь: область стороны «организация» реестра. */
  private tenantPolicies(): string[] {
    return LIFECYCLE_POLICY_IDS.filter((id) => {
      const p = lifecyclePolicy(id)!;
      if (p.ownerKey.kind === 'global') return false;
      const t = lifecycleTableOf(p);
      return !!t && !!pkFieldOf(t) && !!exportScopeSql(p, t, 'workspace', ZERO_UUID);
    });
  }

  plan(): string[] {
    return this.tenantPolicies();
  }

  async skipReason(): Promise<'entitlement' | null> {
    return null;
  }

  /** Страница строк КАК ЕСТЬ: `to_jsonb` таблицы (имена колонок базы), keyset по ключу. */
  async page(ctx: LifecycleExportContext, policyId: string, cursor: string | null, limit: number): Promise<LifecycleCollectedPage> {
    const p = lifecyclePolicy(policyId);
    const t = p ? lifecycleTableOf(p) : null;
    if (!p || !t) throw new Error(`lifecycle restore: ${policyId} is not a model`);
    const scope = exportScopeSql(p, t, 'workspace', ctx.subjectId)!;
    const pk = pkFieldOf(t)!;
    const col = Prisma.raw(`t.${q(t.pk[0]!)}`);
    const after = cursor === null ? Prisma.sql`TRUE` : pk.type === 'BigInt' ? Prisma.sql`${col} > ${cursor}::bigint` : Prisma.sql`${col} > ${cursor}::uuid`;
    const rows = await this.source().$queryRaw<Array<{ id: string; j: string }>>`
      SELECT ${col}::text AS id, to_jsonb(t)::text AS j FROM ${t.ident} t WHERE ${scope} AND ${after} ORDER BY ${col} LIMIT ${limit}`;
    return { rows: [], lines: rows.map((r) => r.j), next: rows.length === limit ? rows[rows.length - 1]!.id : null, files: [], guarded: [] };
  }

  /** Предпросмотр извлечения: строк по моделям в источнике (сотрудник видит объём ДО архива). */
  async previewExtract(workspaceId: string): Promise<Array<{ policyId: string; rows: number }>> {
    this.assertSource();
    const out: Array<{ policyId: string; rows: number }> = [];
    for (const id of this.tenantPolicies()) {
      const p = lifecyclePolicy(id)!;
      const t = lifecycleTableOf(p)!;
      const [r] = await this.source().$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ${t.ident} t WHERE ${exportScopeSql(p, t, 'workspace', workspaceId)!}`;
      const n = Number(r?.n ?? 0);
      if (n) out.push({ policyId: id, rows: n });
    }
    return out;
  }

  /** Стирание организации прошло горячую фазу — восстанавливать нечего (стирание побеждает). */
  async assertNotErased(workspaceId: string): Promise<void> {
    const erased = await this.db.lifecycleErasureRequest.findFirst({
      where: { subjectType: 'workspace', subjectId: workspaceId, status: { in: ['hot_purged', 'keys_destroyed', 'completed'] } },
      select: { id: true },
    });
    if (erased) throw conflict('lifecycle.restoreErased');
  }

  // ============================================================
  // Импорт
  // ============================================================

  /** Архив восстановления с живой подписью платформы и целыми кусками — или отказ. */
  async loadManifest(exportId: string): Promise<LifecycleExportManifest> {
    const row = await this.db.lifecycleExport.findUnique({ where: { id: exportId } });
    if (!row || row.mode !== 'restore') throw notFound('lifecycle.exportNotFound');
    if (row.status !== 'ready' || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) throw conflict('lifecycle.exportNotReady');
    const { stream } = await this.storage.getStream(`${LIFECYCLE_EXPORT_PREFIX}${exportId}/manifest.json`).catch(() => {
      throw conflict('lifecycle.restoreSignatureInvalid');
    });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    let m: LifecycleExportManifest;
    try {
      m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as LifecycleExportManifest;
    } catch {
      throw conflict('lifecycle.restoreSignatureInvalid');
    }
    if (!m.signature || m.mode !== 'restore' || m.exportId !== exportId || m.subject?.type !== 'workspace' || m.subject.id !== row.subjectId) throw conflict('lifecycle.restoreSignatureInvalid');
    const res = await this.signing.verifyArchival('lifecycle', { kid: m.signature.kid, data: lifecycleExportManifestPayload(m), sig: m.signature.sig, signedAt: row.readyAt ?? row.createdAt });
    if (!res.ok) throw conflict('lifecycle.restoreSignatureInvalid');
    for (const e of m.entries) if (!lifecyclePolicy(e.policyId) || !/^data\/[A-Za-z0-9]+\.\d{3}\.jsonl$/.test(e.path)) throw conflict('lifecycle.restoreSignatureInvalid');
    return m;
  }

  /** Предпросмотр импорта: строк в архиве и сколько из них уже есть (будут пропущены). */
  async previewImport(exportId: string): Promise<{ workspaceId: string; snapshotAt: string; tables: Array<{ policyId: string; rows: number; present: number }> }> {
    const m = await this.loadManifest(exportId);
    await this.assertNotErased(m.subject.id);
    const tables = new Map<string, { rows: number; present: number }>();
    for (const e of m.entries) {
      const p = lifecyclePolicy(e.policyId)!;
      const t = lifecycleTableOf(p)!;
      const rows = await this.readEntry(exportId, e.path, e.sha256);
      const ids = rows.map((r) => String(r.row[t.pk[0]!]));
      const present = ids.length ? await this.countPresent(this.db, t, ids) : 0;
      const cur = tables.get(e.policyId) ?? { rows: 0, present: 0 };
      tables.set(e.policyId, { rows: cur.rows + rows.length, present: cur.present + present });
    }
    return { workspaceId: m.subject.id, snapshotAt: m.snapshotAt, tables: [...tables].map(([policyId, v]) => ({ policyId, ...v })) };
  }

  /** Старт импорта В транзакции команды: прогон + джоб коммитятся вместе с журналом команды. */
  async startImport(tx: Tx, exportId: string): Promise<{ runId: string }> {
    const m = await this.loadManifest(exportId);
    await this.assertNotErased(m.subject.id);
    const running = await tx.lifecycleRun.findFirst({ where: { kind: 'restore', status: 'running', subjectId: m.subject.id }, select: { id: true } });
    if (running) throw conflict('lifecycle.restoreRunning');
    const state: ImportState = {
      exportId,
      workspaceId: m.subject.id,
      snapshotAt: m.snapshotAt,
      order: await this.orderEntries(m),
      step: 0,
      tables: {},
      retry: [],
      people: [],
      missingBlobs: 0,
      erasuresReplayed: 0,
      phase: 'rows',
    };
    const runId = await this.runs.start(tx, { kind: 'restore', subjectType: 'workspace', subjectId: m.subject.id, report: { state } as unknown as Record<string, unknown> });
    await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.restore, payload: { runId }, uniqueKey: `restore:${runId}` });
    return { runId };
  }

  /** Порядок кусков: таблицы по внешним ключам живой базы (родители раньше детей), внутри — по номеру. */
  private async orderEntries(m: LifecycleExportManifest): Promise<number[]> {
    const tableOf = new Map<string, string>();
    for (const e of m.entries) tableOf.set(e.policyId, lifecycleTableOf(lifecyclePolicy(e.policyId)!)!.name);
    const names = [...new Set(tableOf.values())];
    const fks = await this.db.$queryRaw<Array<{ child: string; parent: string }>>`
      SELECT cn.nspname || '.' || cc.relname AS child, pn.nspname || '.' || pc.relname AS parent
        FROM pg_constraint c
        JOIN pg_class cc ON cc.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cc.relnamespace
        JOIN pg_class pc ON pc.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pc.relnamespace
       WHERE c.contype = 'f' AND c.conrelid <> c.confrelid`;
    const parents = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
    for (const fk of fks) if (parents.has(fk.child) && parents.has(fk.parent)) parents.get(fk.child)!.add(fk.parent);
    const done = new Set<string>();
    const order: string[] = [];
    const visit = (n: string, stack: Set<string>) => {
      if (done.has(n) || stack.has(n)) return;
      stack.add(n);
      for (const p of parents.get(n) ?? []) visit(p, stack);
      stack.delete(n);
      done.add(n);
      order.push(n);
    };
    for (const n of names) visit(n, new Set());
    const rank = new Map(order.map((n, i) => [n, i]));
    return m.entries
      .map((e, i) => ({ i, r: rank.get(tableOf.get(e.policyId)!) ?? 0, path: e.path }))
      .sort((a, b) => a.r - b.r || a.path.localeCompare(b.path))
      .map((x) => x.i);
  }

  /** Кусок архива: строки текстом (как извлечены) и разобранные (ключ, люди); хэш сверяется с подписанным манифестом. */
  private async readEntry(exportId: string, path: string, sha256: string): Promise<Array<{ raw: string; row: Row }>> {
    const { stream } = await this.storage.getStream(`${LIFECYCLE_EXPORT_PREFIX}${exportId}/${path}`);
    const hash = createHash('sha256');
    const out: Array<{ raw: string; row: Row }> = [];
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      hash.update(line + '\n');
      if (line.trim()) out.push({ raw: line, row: JSON.parse(line) as Row });
    }
    // Кусок не тот, что подписан в манифесте — импорт не идёт ни строкой
    if (hash.digest('hex') !== sha256) throw new JobDiscardError(`restore archive chunk ${path} does not match the signed manifest`);
    return out;
  }

  private async countPresent(client: PrismaClient | Tx, t: LifecycleTable, ids: readonly string[]): Promise<number> {
    const pk = pkFieldOf(t)!;
    const col = Prisma.raw(`t.${q(t.pk[0]!)}`);
    const cast = pk.type === 'BigInt' ? Prisma.sql`${[...ids]}::bigint[]` : Prisma.sql`${[...ids]}::uuid[]`;
    const [r] = await client.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ${t.ident} t WHERE ${col} = ANY(${cast})`;
    return Number(r?.n ?? 0);
  }

  /** Колонки вставки: всё, кроме генерируемых базой (tsvector поиска и т.п.). */
  private async insertColumns(t: LifecycleTable): Promise<TableColumns> {
    const hit = this.columns.get(t.name);
    if (hit) return hit;
    const [schema, table] = t.name.split('.') as [string, string];
    const cols = await this.db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = ${schema} AND table_name = ${table} AND is_generated = 'NEVER'
       ORDER BY ordinal_position`;
    const res = { insert: cols.map((c) => c.column_name) };
    this.columns.set(t.name, res);
    return res;
  }

  /** Заход импорта под замком прогона: протухшая аренда и новый воркер не вставляют вдвоём. */
  private async handle(runId: string): Promise<void> {
    if (!runId) throw new JobDiscardError('run id is empty');
    const ran = await this.redis.withLock(`lifecycle:restore-lease:${runId}`, LIFECYCLE_LIMITS.jobBudgetMs + 120_000, async () => {
      await this.pass(runId);
      return true;
    });
    if (ran === null) throw new JobSnoozeError(30_000, 'another pass of this restore is running');
  }

  /** Дев-полигон: довести импорт сейчас (заходы подряд вместо снузов джоба). */
  async runNow(runId: string): Promise<LifecycleRestoreReportDto> {
    for (let i = 0; i < 500; i += 1) {
      try {
        await this.handle(runId);
      } catch (err) {
        if (!(err instanceof JobSnoozeError)) {
          if (err instanceof JobDiscardError) await this.runs.finish(runId, 'failed', { report: { error: err.message.slice(0, 500) } });
          else throw err;
        }
      }
      const run = await this.runs.get(runId);
      if (!run || run.status !== 'running') break;
    }
    return this.report(runId);
  }

  private async pass(runId: string): Promise<void> {
    const run = await this.runs.get(runId);
    if (!run || run.kind !== 'restore' || run.status !== 'running') return;
    const state = (run.report as { state?: ImportState }).state;
    if (!state) throw new JobDiscardError('restore run has no state');
    const deadline = Date.now() + LIFECYCLE_LIMITS.jobBudgetMs;
    let m: LifecycleExportManifest;
    try {
      m = await this.loadManifest(state.exportId);
    } catch (err) {
      await this.runs.finish(runId, 'failed', { report: { error: (err as { code?: string }).code ?? 'manifest' } });
      return;
    }
    if (state.phase === 'rows') {
      while (state.step < state.order.length) {
        if (Date.now() > deadline) {
          await this.runs.saveState(runId, { state });
          throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'budget spent, continuing');
        }
        const entryIndex = state.order[state.step]!;
        await this.importEntry(m, entryIndex, state, null);
        state.step += 1;
        await this.runs.saveState(runId, { state });
      }
      state.phase = 'retry';
      await this.runs.saveState(runId, { state });
    }
    if (state.phase === 'retry') {
      // Строки, чей родитель пришёл позже в том же импорте, — вторая попытка
      const byEntry = new Map<number, number[]>();
      for (const r of state.retry) byEntry.set(r.entry, [...(byEntry.get(r.entry) ?? []), r.line]);
      state.retry = [];
      for (const [entry, lines] of byEntry) await this.importEntry(m, entry, state, new Set(lines), true);
      state.phase = 'replay';
      await this.runs.saveState(runId, { state });
    }
    if (state.phase === 'replay') {
      state.erasuresReplayed = await this.replayErasures(state);
      state.phase = 'done';
      await this.runs.saveState(runId, { state });
    }
    const tables = Object.values(state.tables);
    const sum = (k: 'inserted' | 'skipped' | 'failed') => tables.reduce((a, t) => a + t[k], 0);
    await this.db.$transaction(async (tx) => {
      await this.audit.record(tx, {
        key: 'lifecycle.restore.imported',
        actor: { kind: 'system' },
        workspaceId: state.workspaceId,
        target: { type: 'workspace', id: state.workspaceId },
        details: { tables: tables.length, inserted: sum('inserted'), skipped: sum('skipped'), failed: sum('failed'), erasuresReplayed: state.erasuresReplayed },
      });
    });
    await this.runs.progress(null, runId, sum('inserted'), tables.length);
    await this.runs.finish(runId, 'done', { report: { state } as unknown as Record<string, unknown> });
    this.logger.log(`tenant restore ${runId} of ${state.workspaceId}: +${sum('inserted')} rows, ${sum('skipped')} skipped, ${sum('failed')} failed, ${state.erasuresReplayed} erasures replayed`);
  }

  /**
   * Один кусок архива: пачками — проверка «все строки этой организации» НА ЗНАЧЕНИЯХ строк
   * (область реестра над `jsonb_populate_recordset`), затем вставка с сохранением id и
   * пропуском существующего. Пачка, отвергнутая базой (внешний ключ на то, чего нет), — по
   * строке под SAVEPOINT: отвергнутые запоминаются на вторую попытку.
   */
  private async importEntry(m: LifecycleExportManifest, entryIndex: number, state: ImportState, only: Set<number> | null, final = false): Promise<void> {
    const e = m.entries[entryIndex]!;
    const p = lifecyclePolicy(e.policyId)!;
    const t = lifecycleTableOf(p)!;
    const rows = await this.readEntry(state.exportId, e.path, e.sha256);
    const cols = await this.insertColumns(t);
    const colList = Prisma.raw(cols.insert.map(q).join(', '));
    const scope = exportScopeSql(p, t, 'workspace', state.workspaceId)!;
    const report = (state.tables[e.policyId] ??= { policyId: e.policyId, inserted: 0, skipped: 0, failed: 0 });
    const people = new Set(state.people);
    const subjectCols = p.subjects.map((s) => t.fields.get(s.column)?.column).filter((c): c is string => !!c);

    const lines = rows.map((r, line) => ({ r: r.row, raw: r.raw, line })).filter((x) => !only || only.has(x.line));
    for (let i = 0; i < lines.length; i += IMPORT_BATCH) {
      const batch = lines.slice(i, i + IMPORT_BATCH);
      // Текст строк как извлечён: разбор и повторная сериализация потеряли бы точность bigint
      const json = `[${batch.map((x) => x.raw).join(',')}]`;
      const [foreign] = await this.db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM jsonb_populate_recordset(NULL::${t.ident}, ${json}::jsonb) t WHERE NOT (${scope})`;
      if (Number(foreign?.n ?? 0) > 0) throw new JobDiscardError(`restore archive has rows of another tenant in ${e.policyId} — import stopped`);
      const insertOne = (tx: Tx, payload: string) =>
        tx.$executeRaw`INSERT INTO ${t.ident} (${colList}) OVERRIDING SYSTEM VALUE
          SELECT ${colList} FROM jsonb_populate_recordset(NULL::${t.ident}, ${payload}::jsonb) ON CONFLICT DO NOTHING`;
      try {
        const n = await this.db.$transaction((tx) => insertOne(tx, json));
        report.inserted += n;
        report.skipped += batch.length - n;
      } catch {
        // По строке: чужой внешний ключ одной строки не валит пачку
        for (const x of batch) {
          try {
            const n = await this.db.$transaction((tx) => insertOne(tx, `[${x.raw}]`));
            report.inserted += n;
            report.skipped += 1 - n;
          } catch {
            if (!final && state.retry.length < RETRY_CAP) state.retry.push({ entry: entryIndex, line: x.line });
            else report.failed += 1;
          }
        }
      }
      for (const x of batch) {
        for (const c of subjectCols) {
          const v = x.r[c];
          if (typeof v === 'string' && people.size < PEOPLE_CAP) people.add(v);
        }
      }
      if (e.policyId === 'FileObject') {
        for (const x of batch) {
          const key = x.r['storage_key'];
          if (typeof key === 'string' && (await this.storage.size(key)) === null) state.missingBlobs += 1;
        }
      }
    }
    state.people = [...people];
  }

  /**
   * Реплей стираний: люди из вернувшихся строк, чьё стирание прошло после снимка (или ещё
   * идёт), стираются в них заново — вернувшиеся из бэкапа имена и сообщения стёртого не
   * переживут его (Dropbox 2017: «карантин» вернул удалённое). По живой заявке шаги плана
   * проходят заново (статус не меняется), по завершённой — новая заявка.
   */
  private async replayErasures(state: ImportState): Promise<number> {
    if (!state.people.length) return 0;
    const snapshotAt = new Date(state.snapshotAt);
    let n = 0;
    for (let i = 0; i < state.people.length; i += 1000) {
      const ids = state.people.slice(i, i + 1000);
      const reqs = await this.db.lifecycleErasureRequest.findMany({
        where: {
          subjectType: 'user',
          subjectId: { in: ids },
          status: { notIn: ['cancelled', 'scheduled'] },
          OR: [{ hotPurgedAt: null }, { hotPurgedAt: { gte: snapshotAt } }],
        },
        select: { subjectId: true },
        distinct: ['subjectId'],
      });
      for (const r of reqs) if ((await this.erasure.replayUser(r.subjectId)) !== 'none') n += 1;
    }
    return n;
  }

  // ============================================================
  // Кабинет: архивы и прогоны
  // ============================================================

  async archives(limit = 50): Promise<LifecycleRestoreArchiveDto[]> {
    const rows = await this.db.lifecycleExport.findMany({ where: { mode: 'restore' }, orderBy: { createdAt: 'desc' }, take: limit });
    if (!rows.length) return [];
    const runs = await this.db.lifecycleRun.findMany({ where: { kind: 'restore', subjectId: { in: [...new Set(rows.map((r) => r.subjectId))] } }, orderBy: { startedAt: 'desc' }, take: 200 });
    return rows.map((r) => ({
      exportId: r.id,
      workspaceId: r.subjectId,
      status: r.status as LifecycleRestoreArchiveDto['status'],
      rows: r.rows,
      snapshotAt: r.snapshotAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      imports: runs
        .filter((x) => (x.report as { state?: ImportState } | null)?.state?.exportId === r.id)
        .map((x) => this.reportOf(x.id, x.status, (x.report as unknown as { state: ImportState }).state)),
    }));
  }

  private reportOf(runId: string, status: string, s: ImportState): LifecycleRestoreReportDto {
    return {
      runId,
      exportId: s.exportId,
      workspaceId: s.workspaceId,
      snapshotAt: s.snapshotAt,
      status: status === 'done' ? 'done' : status === 'running' ? 'running' : 'failed',
      tables: Object.values(s.tables),
      erasuresReplayed: s.erasuresReplayed,
      missingBlobs: s.missingBlobs,
    };
  }

  /** Отчёт прогона импорта (сьют, скрипт рунбука). */
  async report(runId: string): Promise<LifecycleRestoreReportDto> {
    const run = await this.runs.get(runId);
    const state = (run?.report as { state?: ImportState } | undefined)?.state;
    if (!run || run.kind !== 'restore' || !state) throw notFound('lifecycle.restoreRunNotFound');
    return this.reportOf(run.id, run.status, state);
  }
}
