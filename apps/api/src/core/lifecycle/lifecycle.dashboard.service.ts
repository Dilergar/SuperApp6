import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIFECYCLE_BACKUP_WINDOW_DAYS,
  LIFECYCLE_FOREVER,
  LIFECYCLE_LIMITS,
  LIFECYCLE_POLICY_IDS,
  lifecyclePolicy,
  resolveLifecycleRetention,
  type LifecycleBackupKind,
  type LifecycleBackupReportInput,
  type LifecycleBackupRunDto,
  type LifecycleBackupStatus,
  type LifecycleDataBackupsDto,
  type LifecycleDataCanaryDto,
  type LifecycleDataErasureDto,
  type LifecycleDataOverviewDto,
  type LifecycleDataRetentionDto,
  type LifecycleDataStorageDto,
  type LifecycleErasureStatus,
  type LifecycleHealthLevel,
  type LifecyclePolicy,
  type LifecycleUnusedIndexDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleOverrides } from './lifecycle.overrides';
import { LifecyclePartitions, type LifecyclePartitionHealth } from './lifecycle.partitions';
import { LifecyclePurgeRunner } from './lifecycle.purge';
import { isQueryTimeout, lifecycleTableOf } from './lifecycle.sql';
import { msUntilPurgeWindow } from './lifecycle.window';

const DAY_MS = 86_400_000;
/** Пороги возраста XID (plan §9): предупреждение 500 млн, «страница» 1 млрд. */
const XID_WARN = 500_000_000;
const XID_PAGE = 1_000_000_000;
/** Бэкап без успеха дольше — тревога «нет бэкапа» (GitLab 2017: алерт на ОТСУТСТВИЕ). */
const BACKUP_STALE_MS = 26 * 3600_000;
/** Отставание срока терпимо на сутки (ночной прогон). */
const LAG_TOLERANCE_DAYS = 1;
/** Тяжёлые вкладки считаются не чаще раза в 30 секунд на процесс. */
const CACHE_MS = 30_000;
/** Строк очереди стираний на вкладке (итоги — в плитке обзора). */
const ERASURE_QUEUE_MAX = 200;
/**
 * Конечные для дашборда — только завершённое и отменённое. Упавшее (`failed`) остаётся в
 * очереди и сразу «застряло»: само оно не продолжится, повтор — команда `lifecycle.erasure.retry`.
 */
const TERMINAL: LifecycleErasureStatus[] = ['completed', 'cancelled'];

interface TableStat {
  name: string;
  bytes: bigint;
  rows: bigint;
}

/** «Имя таблицы» реестра → политика (модель Prisma или сырая таблица). */
function policyByTable(): Map<string, LifecyclePolicy> {
  const out = new Map<string, LifecyclePolicy>();
  for (const id of LIFECYCLE_POLICY_IDS) {
    const p = lifecyclePolicy(id)!;
    if (p.store.kind === 'table') out.set(p.store.table, p);
    const t = lifecycleTableOf(p);
    if (t) out.set(t.name, p);
  }
  return out;
}

/** Колонка срока политики (у ведомых раннером и сбросом партиций). */
function retentionColumn(p: LifecyclePolicy): string | null {
  const en = p.enforcement;
  return en.kind === 'batched_delete' || en.kind === 'drop_partition' ? en.column : null;
}

/** Действующий срок политики в сутках (переопределение Кабинета — не ниже пола); null — вечно. */
function effectiveDays(p: LifecyclePolicy, overrideDays: number | null): number | null {
  if (overrideDays) {
    const floor = p.retention.floorDays;
    return typeof floor === 'number' && overrideDays < floor ? floor : overrideDays;
  }
  const { days } = resolveLifecycleRetention({ policy: p });
  return days === LIFECYCLE_FOREVER || days === 0 ? null : days;
}

function worst(...levels: LifecycleHealthLevel[]): LifecycleHealthLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  if (levels.every((l) => l === 'unknown')) return 'unknown';
  return 'ok';
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Дашборд «Данные» Кабинета (core/lifecycle Э5): база, бэкапы, партиции, сроки хранения,
 * стирания, канарейка. Сводку кластера отдаёт функция монитора `lifecycle_db_overview()`
 * (числа, без текстов запросов); размеры и старейшие строки — ночной снимок
 * `lifecycle_storage_daily`; бэкапы — отчёты скриптов (`lifecycle_backup_runs`).
 */
@Injectable()
export class LifecycleDashboardService {
  private readonly logger = new Logger(LifecycleDashboardService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly partitions: LifecyclePartitions,
    private readonly overrides: LifecycleOverrides,
    private readonly holds: LifecycleHoldsService,
    private readonly purge: LifecyclePurgeRunner,
  ) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Сбросить кэш вкладок (после команды Кабинета: пауза, срок, повтор). */
  invalidate(): void {
    this.cache.clear();
  }

  // ============================================================
  // Обзор
  // ============================================================

  overview(): Promise<LifecycleDataOverviewDto> {
    return this.cached('overview', async () => {
      const now = new Date();
      const [dbRow] = await this.db.$queryRaw<
        Array<{
          xid_age: bigint;
          db_bytes: bigint;
          connections: number;
          max_connections: number;
          lock_waiters: number;
          lwlock_lockmanager: number;
          replicas: number;
          max_replay_lag: number;
          invalid_indexes: number;
          detach_pending: number;
        }>
      >`SELECT * FROM lifecycle_db_overview()`;
      const xidAge = Number(dbRow?.xid_age ?? 0);
      const lag = Number(dbRow?.max_replay_lag ?? 0);
      const dbLevel: LifecycleHealthLevel =
        xidAge >= XID_PAGE || lag >= 10 ? 'critical' : xidAge >= XID_WARN || lag >= 1 || (dbRow?.invalid_indexes ?? 0) > 0 ? 'warning' : 'ok';

      const backups = await this.backupsState(now);
      const partHealth = await this.partitions.health(now).catch((): LifecyclePartitionHealth[] => []);
      const minAhead = partHealth.length ? Math.min(...partHealth.map((h) => h.ahead)) : null;
      const detachPending = partHealth.reduce((a, h) => a + h.detachPending, 0);
      const partLevel: LifecycleHealthLevel = minAhead === null ? 'unknown' : minAhead < 1 || detachPending > 0 ? 'critical' : minAhead < 2 ? 'warning' : 'ok';

      const retention = await this.retentionRows(now);
      const lagging = retention.rows.filter((r) => (r.lagDays ?? 0) > LAG_TOLERANCE_DAYS);
      const maxLag = lagging.reduce((a, r) => Math.max(a, r.lagDays ?? 0), 0);
      const retLevel: LifecycleHealthLevel = retention.snapshotDay === null ? 'unknown' : lagging.length ? (maxLag > 7 ? 'critical' : 'warning') : 'ok';

      const er = await this.erasureCounts(now);
      const erLevel: LifecycleHealthLevel = er.stuck > 0 ? 'critical' : er.held > 0 ? 'warning' : 'ok';

      const canary = await this.lastCanary();
      const canaryLevel: LifecycleHealthLevel = !canary ? 'unknown' : !canary.ok ? 'critical' : canary.unseeded > 0 ? 'warning' : 'ok';

      const attention: LifecycleDataOverviewDto['attention'] = [];
      if (backups.level === 'critical' && !backups.lastSuccessAt) attention.push({ code: 'backup_never', severity: 'critical', params: {} });
      else if (backups.lastSuccessAt && now.getTime() - new Date(backups.lastSuccessAt).getTime() > BACKUP_STALE_MS)
        attention.push({ code: 'backup_missing', severity: 'critical', params: { hours: Math.floor((now.getTime() - new Date(backups.lastSuccessAt).getTime()) / 3600_000) } });
      if (backups.lastFailedAt) attention.push({ code: 'backup_failed', severity: 'warning', params: { at: backups.lastFailedAt } });
      if (backups.lastDrill && !backups.lastDrill.ok) attention.push({ code: 'drill_failed', severity: 'critical', params: { at: backups.lastDrill.at } });
      if (minAhead !== null && minAhead < 2) attention.push({ code: 'partition_runway_low', severity: minAhead < 1 ? 'critical' : 'warning', params: { months: minAhead } });
      if (detachPending > 0) attention.push({ code: 'detach_pending', severity: 'critical', params: { count: detachPending } });
      if (lagging.length) attention.push({ code: 'retention_lag', severity: maxLag > 7 ? 'critical' : 'warning', params: { count: lagging.length, days: maxLag } });
      if (er.stuck > 0) attention.push({ code: 'erasure_stuck', severity: 'critical', params: { count: er.stuck } });
      if (er.held > 0) attention.push({ code: 'erasure_held', severity: 'warning', params: { count: er.held } });
      if (canary && !canary.ok) attention.push({ code: 'canary_failed', severity: 'critical', params: { findings: canary.findings } });
      if (canary && canary.unseeded > 0) attention.push({ code: 'canary_unseeded', severity: 'warning', params: { count: canary.unseeded } });
      if (xidAge >= XID_WARN) attention.push({ code: 'xid_age_high', severity: xidAge >= XID_PAGE ? 'critical' : 'warning', params: { millions: Math.round(xidAge / 1_000_000) } });
      if (lag >= 1) attention.push({ code: 'replica_lag', severity: lag >= 10 ? 'critical' : 'warning', params: { seconds: Math.round(lag) } });
      if ((dbRow?.invalid_indexes ?? 0) > 0) attention.push({ code: 'invalid_indexes', severity: 'warning', params: { count: dbRow!.invalid_indexes } });
      attention.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

      return {
        checkedAt: now.toISOString(),
        database: {
          level: dbLevel,
          xidAge,
          xidLimit: XID_PAGE,
          dbBytes: Number(dbRow?.db_bytes ?? 0),
          connections: dbRow?.connections ?? 0,
          maxConnections: dbRow?.max_connections ?? 0,
          replicas: dbRow?.replicas ?? 0,
          maxReplayLagSeconds: lag,
          lockWaiters: dbRow?.lock_waiters ?? 0,
          lockManagerWaits: dbRow?.lwlock_lockmanager ?? 0,
          invalidIndexes: dbRow?.invalid_indexes ?? 0,
        },
        backups: { level: backups.level, lastSuccessAt: backups.lastSuccessAt, coveredDays: backups.coveredDays, windowDays: LIFECYCLE_BACKUP_WINDOW_DAYS, repos: backups.repos, lastDrill: backups.lastDrill },
        partitions: { level: partLevel, parents: partHealth.length, minAhead, detachPending },
        retention: { level: retLevel, lagging: lagging.length, maxLagDays: maxLag, nextRunAt: retention.nextRunAt },
        erasure: { level: erLevel, queued: er.queued, stuck: er.stuck, held: er.held, avgDaysToHotPurge: er.avgDaysToHotPurge },
        canary: { level: canaryLevel, lastRunAt: canary?.at ?? null, lastOk: canary?.ok ?? null, findings: canary?.findings ?? 0, unseeded: canary?.unseeded ?? 0 },
        growth: await this.growth(90),
        deletedPerDay: await this.deletedPerDay(30),
        attention,
      };
    });
  }

  /** Светофор для плитки главной Кабинета — худший уровень шести плиток. */
  async overallLevel(): Promise<LifecycleHealthLevel> {
    const o = await this.overview();
    return worst(o.database.level, o.backups.level, o.partitions.level, o.retention.level, o.erasure.level, o.canary.level);
  }

  private async growth(days: number): Promise<LifecycleDataOverviewDto['growth']> {
    const since = new Date(Date.now() - days * DAY_MS);
    const rows = await this.db.$queryRaw<Array<{ day: Date; data_class: string; bytes: bigint }>>`
      SELECT "day", "data_class", sum("bytes")::bigint AS bytes FROM "lifecycle_storage_daily"
       WHERE "day" >= ${isoDay(since)}::date GROUP BY "day", "data_class" ORDER BY "day"`;
    return rows.map((r) => ({ day: isoDay(r.day), dataClass: r.data_class, bytes: Number(r.bytes) }));
  }

  private async deletedPerDay(days: number): Promise<LifecycleDataOverviewDto['deletedPerDay']> {
    const since = new Date(Date.now() - days * DAY_MS);
    const rows = await this.db.$queryRaw<Array<{ day: Date; rows: bigint }>>`
      SELECT date_trunc('day', "started_at" AT TIME ZONE 'UTC')::date AS day, sum("rows")::bigint AS rows
        FROM "lifecycle_runs"
       WHERE "started_at" >= ${since}::timestamptz AND NOT "dry_run" AND "kind" IN ('purge', 'tenant_purge', 'loose_fk', 'erasure')
       GROUP BY 1 ORDER BY 1`;
    return rows.map((r) => ({ day: isoDay(r.day), rows: Number(r.rows) }));
  }

  // ============================================================
  // Хранилище
  // ============================================================

  storage(): Promise<LifecycleDataStorageDto> {
    return this.cached('storage', async () => {
      const byTable = policyByTable();
      const stats = await this.tableStats();
      const top = stats.sort((a, b) => Number(b.bytes - a.bytes)).slice(0, 30);
      const weekAgo = await this.db.lifecycleStorageDaily.findMany({
        where: { day: new Date(isoDay(new Date(Date.now() - 7 * DAY_MS))), tableName: { in: top.map((t) => t.name) } },
        select: { tableName: true, bytes: true },
      });
      const was = new Map(weekAgo.map((w) => [w.tableName, w.bytes]));
      const vac = await this.db.$queryRaw<Array<{ name: string; live: bigint; dead: bigint; last_av: Date | null }>>`
        SELECT s.schemaname || '.' || s.relname AS name, s.n_live_tup AS live, s.n_dead_tup AS dead,
               GREATEST(s.last_autovacuum, s.last_vacuum) AS last_av
          FROM pg_stat_user_tables s`;
      const vacOf = new Map(vac.map((v) => [v.name, v]));
      const invalid = await this.db.$queryRaw<Array<{ name: string; n: bigint }>>`
        SELECT n.nspname || '.' || t.relname AS name, count(*)::bigint AS n
          FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE NOT i.indisvalid GROUP BY 1`;
      const invalidOf = new Map(invalid.map((r) => [r.name, Number(r.n)]));
      const [dbRow] = await this.db.$queryRaw<Array<{ connections: number; connections_active: number; connections_idle_tx: number; max_connections: number; lock_waiters: number; lwlock_lockmanager: number }>>`
        SELECT connections, connections_active, connections_idle_tx, max_connections, lock_waiters, lwlock_lockmanager FROM lifecycle_db_overview()`;
      return {
        tables: top.map((t) => {
          const p = byTable.get(t.name) ?? null;
          const v = vacOf.get(t.name);
          const live = Number(v?.live ?? t.rows);
          const dead = Number(v?.dead ?? 0);
          const prev = was.get(t.name);
          return {
            table: t.name,
            policyId: p?.id ?? null,
            dataClass: p?.dataClass ?? null,
            bytes: Number(t.bytes),
            growth7dBytes: prev === undefined ? null : Number(t.bytes - prev),
            liveRows: live,
            deadRows: dead,
            bloatPct: live + dead > 0 ? Math.round((dead / (live + dead)) * 1000) / 10 : 0,
            lastAutovacuumAt: v?.last_av?.toISOString() ?? null,
            invalidIndexes: invalidOf.get(t.name) ?? 0,
          };
        }),
        connections: { total: dbRow?.connections ?? 0, active: dbRow?.connections_active ?? 0, idleInTransaction: dbRow?.connections_idle_tx ?? 0, max: dbRow?.max_connections ?? 0 },
        locks: { waiters: dbRow?.lock_waiters ?? 0, lockManager: dbRow?.lwlock_lockmanager ?? 0 },
      };
    });
  }

  /** Размер и строки каждой таблицы верхнего уровня (партиционированная — суммой листьев). */
  private tableStats(): Promise<TableStat[]> {
    return this.db.$queryRaw<TableStat[]>`
      SELECT n.nspname || '.' || c.relname AS name,
             (CASE WHEN c.relkind = 'p'
                   THEN (SELECT COALESCE(sum(pg_total_relation_size(pt.relid)), 0) FROM pg_partition_tree(c.oid) pt WHERE pt.isleaf)
                   ELSE pg_total_relation_size(c.oid) END)::bigint AS bytes,
             (CASE WHEN c.relkind = 'p'
                   THEN (SELECT COALESCE(sum(GREATEST(cl.reltuples, 0)), 0) FROM pg_partition_tree(c.oid) pt JOIN pg_class cl ON cl.oid = pt.relid WHERE pt.isleaf)
                   ELSE GREATEST(c.reltuples, 0) END)::bigint AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
  }

  /**
   * Ночной снимок размеров по таблицам: байты, строки (статистика планировщика) и старейшая
   * строка по колонке срока у ведомых политик (с таймаутом: без индекса по колонке — пропуск).
   * Повтор за день перезаписывает день. Возвращает число таблиц.
   */
  async snapshotStorage(now = new Date()): Promise<number> {
    const byTable = policyByTable();
    const day = new Date(isoDay(now));
    let n = 0;
    for (const t of await this.tableStats()) {
      const p = byTable.get(t.name) ?? null;
      let oldestAt: Date | null = null;
      const column = p ? retentionColumn(p) : null;
      const table = p ? lifecycleTableOf(p) : null;
      if (p && column && table) {
        const field = table.fields.get(column);
        if (field) {
          try {
            const [row] = await this.db.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
              return tx.$queryRaw<Array<{ oldest: Date | null }>>(Prisma.sql`SELECT min(t.${Prisma.raw(`"${field.column}"`)}) AS oldest FROM ${table.ident} t`);
            });
            oldestAt = row?.oldest ?? null;
          } catch (err) {
            if (!isQueryTimeout(err)) this.logger.warn(`storage snapshot: ${t.name}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      const data = { policyId: p?.id ?? null, dataClass: p?.dataClass ?? 'unclassified', bytes: t.bytes, rows: t.rows, oldestAt };
      await this.db.lifecycleStorageDaily.upsert({ where: { day_tableName: { day, tableName: t.name } }, create: { day, tableName: t.name, ...data }, update: data });
      n++;
    }
    this.cache.clear();
    return n;
  }

  // ============================================================
  // Сроки хранения
  // ============================================================

  retention(): Promise<LifecycleDataRetentionDto> {
    return this.cached('retention', () => this.retentionRows(new Date()));
  }

  /** Отставание сроков для метрик — тот же допуск, что у плитки обзора. */
  async retentionLag(): Promise<{ lagging: number; maxLagDays: number }> {
    const r = await this.retention();
    const lagging = r.rows.filter((x) => (x.lagDays ?? 0) > LAG_TOLERANCE_DAYS);
    return { lagging: lagging.length, maxLagDays: lagging.reduce((a, x) => Math.max(a, x.lagDays ?? 0), 0) };
  }

  /** Свежесть бэкапов для метрик: последний успех по репозиторию и последнее успешное учение. */
  async backupFreshness(): Promise<{ repos: Array<{ repo: string; lastSuccessAt: string | null }>; lastDrillOkAt: string | null }> {
    const s = await this.backupsState(new Date());
    const b = await this.backups();
    return { repos: s.repos, lastDrillOkAt: b.drills.find((d) => d.status === 'ok')?.startedAt ?? null };
  }

  private async retentionRows(now: Date): Promise<LifecycleDataRetentionDto> {
    const overrides = await this.overrides.all();
    const lastDay = await this.db.lifecycleStorageDaily.findFirst({ orderBy: { day: 'desc' }, select: { day: true } });
    const snap = lastDay ? await this.db.lifecycleStorageDaily.findMany({ where: { day: lastDay.day, policyId: { not: null } }, select: { policyId: true, rows: true, oldestAt: true }, take: 2000 }) : [];
    const snapOf = new Map(snap.map((s) => [s.policyId!, s]));
    const runs = await this.db.$queryRaw<Array<{ id: string; policy_id: string; status: string; dry_run: boolean; rows: bigint; expected_rows: bigint | null; stopped_reason: string | null; started_at: Date; finished_at: Date | null }>>`
      SELECT DISTINCT ON ("policy_id") "id"::text AS id, "policy_id", "status", "dry_run", "rows", "expected_rows", "stopped_reason", "started_at", "finished_at"
        FROM "lifecycle_runs" WHERE "kind" = 'purge' AND "policy_id" IS NOT NULL
       ORDER BY "policy_id", "started_at" DESC`;
    const runOf = new Map(runs.map((r) => [r.policy_id, r]));
    const rows: LifecycleDataRetentionDto['rows'] = [];
    for (const id of LIFECYCLE_POLICY_IDS) {
      const p = lifecyclePolicy(id)!;
      const ov = overrides.get(id) ?? null;
      const s = snapOf.get(id);
      const days = effectiveDays(p, ov?.days ?? null);
      const lagDays = s?.oldestAt && days !== null ? Math.max(0, Math.floor((now.getTime() - s.oldestAt.getTime()) / DAY_MS) - days) : null;
      const r = runOf.get(id);
      const en = p.enforcement;
      rows.push({
        policyId: id,
        dataClass: p.dataClass,
        owner: p.owner,
        enforcement: en.kind,
        retention: { floorDays: p.retention.floorDays ?? null, defaultDays: p.retention.defaultDays, ceilingDays: p.retention.ceilingDays ?? null },
        tenantConfigurable: !!p.retention.tenantConfigurable,
        // Те же условия, что проверяют команды: Кабинет не предлагает отвергаемого
        runnable: !!(await this.purge.modeOf(p)),
        overridable: en.kind === 'batched_delete' && !en.handler,
        override: ov ? { paused: ov.paused, days: ov.days, reason: ov.reason, changedAt: ov.changedAt.toISOString() } : null,
        rows: s ? Number(s.rows) : null,
        oldestAt: s?.oldestAt?.toISOString() ?? null,
        lagDays,
        lastRun: r
          ? { id: r.id, status: r.status, dryRun: r.dry_run, rows: Number(r.rows), expectedRows: r.expected_rows === null ? null : Number(r.expected_rows), stoppedReason: r.stopped_reason, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null }
          : null,
      });
    }
    return { rows, nextRunAt: new Date(now.getTime() + msUntilPurgeWindow(now)).toISOString(), snapshotDay: lastDay ? isoDay(lastDay.day) : null };
  }

  // ============================================================
  // Стирания и заморозки
  // ============================================================

  async erasure(): Promise<LifecycleDataErasureDto> {
    const now = new Date();
    const stuckBefore = new Date(now.getTime() - LIFECYCLE_LIMITS.erasure.stuckDays * DAY_MS);
    // Проблемные (упавшие и застрявшие) — первыми: длинная очередь, обрезанная по дате заявки,
    // спрятала бы как раз то, ради чего вкладку открывают
    const problems = await this.db.lifecycleErasureRequest.findMany({
      where: { OR: [{ status: 'failed' }, { status: { in: ['scheduled', 'running'] }, effectiveAt: { lt: stuckBefore }, lastProgressAt: { lt: stuckBefore } }] },
      orderBy: { requestedAt: 'asc' },
      take: ERASURE_QUEUE_MAX,
    });
    const rest = await this.db.lifecycleErasureRequest.findMany({
      where: { status: { notIn: TERMINAL }, id: { notIn: problems.map((p) => p.id) } },
      orderBy: { requestedAt: 'asc' },
      take: ERASURE_QUEUE_MAX - problems.length,
    });
    const live = [...problems, ...rest];
    const completed90d = await this.db.lifecycleErasureRequest.count({ where: { status: 'completed', completedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } } });
    const platformHolds = await this.holds.platformActive();
    const organizationHolds = await this.db.lifecycleHold.count({ where: { createdByKind: 'user', releasedAt: null } });
    return {
      queue: live.map((r) => ({
        id: r.id,
        subjectType: r.subjectType as 'user' | 'workspace',
        pseudonym: r.pseudonym.slice(0, 12),
        status: r.status as LifecycleErasureStatus,
        requestedAt: r.requestedAt.toISOString(),
        effectiveAt: r.effectiveAt.toISOString(),
        hiddenAt: r.hiddenAt?.toISOString() ?? null,
        hotPurgedAt: r.hotPurgedAt?.toISOString() ?? null,
        keysDestroyedAt: r.keysDestroyedAt?.toISOString() ?? null,
        backupsClearAt: r.backupsClearAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        lastProgressAt: r.lastProgressAt.toISOString(),
        attempts: r.attempts,
        errorCode: r.errorCode,
        // Ожидание ключей и окна бэкапов — это срок, а не застревание (как у алерта оркестратора);
        // упавшее застряло сразу
        stuck: r.status === 'failed' || (r.effectiveAt < stuckBefore && r.lastProgressAt < stuckBefore && (r.status === 'scheduled' || r.status === 'running')),
      })),
      completed90d,
      platformHolds,
      organizationHolds,
    };
  }

  private async erasureCounts(now: Date): Promise<{ queued: number; stuck: number; held: number; avgDaysToHotPurge: number | null }> {
    const stuckBefore = new Date(now.getTime() - LIFECYCLE_LIMITS.erasure.stuckDays * DAY_MS);
    const [queued, stuck, held] = await Promise.all([
      this.db.lifecycleErasureRequest.count({ where: { status: { notIn: TERMINAL } } }),
      this.db.lifecycleErasureRequest.count({
        where: { OR: [{ status: 'failed' }, { status: { in: ['scheduled', 'running'] }, effectiveAt: { lt: stuckBefore }, lastProgressAt: { lt: stuckBefore } }] },
      }),
      this.db.lifecycleErasureRequest.count({ where: { status: 'held' } }),
    ]);
    const [avg] = await this.db.$queryRaw<Array<{ days: number | null }>>`
      SELECT avg(EXTRACT(EPOCH FROM ("hot_purged_at" - "requested_at")) / 86400)::float8 AS days
        FROM "lifecycle_erasure_requests"
       WHERE "hot_purged_at" IS NOT NULL AND "hot_purged_at" >= ${new Date(now.getTime() - 90 * DAY_MS)}::timestamptz`;
    return { queued, stuck, held, avgDaysToHotPurge: avg?.days === null || avg?.days === undefined ? null : Math.round(avg.days * 10) / 10 };
  }

  // ============================================================
  // Бэкапы и восстановление
  // ============================================================

  async backups(): Promise<LifecycleDataBackupsDto> {
    const now = new Date();
    const since = new Date(now.getTime() - LIFECYCLE_BACKUP_WINDOW_DAYS * DAY_MS);
    const window = await this.db.lifecycleBackupRun.findMany({ where: { startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 2000 });
    const drills = await this.db.lifecycleBackupRun.findMany({ where: { kind: { in: ['restore_drill', 'pitr_drill', 'dr_drill'] } }, orderBy: { startedAt: 'desc' }, take: 10 });
    const replication = await this.db.lifecycleBackupRun.findFirst({ where: { kind: 's3_replication' }, orderBy: { startedAt: 'desc' } });
    const empty = (await this.db.lifecycleBackupRun.count()) === 0;
    const coverage: LifecycleDataBackupsDto['coverage'] = [];
    for (let i = LIFECYCLE_BACKUP_WINDOW_DAYS - 1; i >= 0; i--) {
      const day = isoDay(new Date(now.getTime() - i * DAY_MS));
      const ofDay = window.filter((r) => r.status === 'ok' && isoDay(r.startedAt) === day);
      coverage.push({ day, backup: ofDay.some((r) => ['full', 'incr', 'diff'].includes(r.kind)), wal: ofDay.some((r) => r.kind === 'wal') });
    }
    const details = (replication?.details ?? {}) as { replicationLagSeconds?: number };
    return {
      windowDays: LIFECYCLE_BACKUP_WINDOW_DAYS,
      coverage,
      runs: window.slice(0, 50).map((r) => this.backupDto(r)),
      drills: drills.map((r) => this.backupDto(r)),
      replication: { lagSeconds: typeof details.replicationLagSeconds === 'number' ? details.replicationLagSeconds : null, at: replication?.startedAt.toISOString() ?? null },
      empty,
    };
  }

  private async backupsState(now: Date): Promise<{
    level: LifecycleHealthLevel;
    lastSuccessAt: string | null;
    lastFailedAt: string | null;
    coveredDays: number;
    repos: Array<{ repo: string; lastSuccessAt: string | null }>;
    lastDrill: { at: string; ok: boolean } | null;
  }> {
    const b = await this.backups();
    const okRuns = b.runs.filter((r) => r.status === 'ok' && ['full', 'incr', 'diff'].includes(r.kind));
    const lastSuccessAt = okRuns[0]?.startedAt ?? null;
    const lastFailed = b.runs.find((r) => r.status === 'failed' && ['full', 'incr', 'diff', 'verify'].includes(r.kind));
    const repos = [...new Set(b.runs.map((r) => r.repo))].sort().map((repo) => ({ repo, lastSuccessAt: okRuns.find((r) => r.repo === repo)?.startedAt ?? null }));
    const lastDrill = b.drills[0] ? { at: b.drills[0].startedAt, ok: b.drills[0].status === 'ok' } : null;
    const stale = !lastSuccessAt || now.getTime() - new Date(lastSuccessAt).getTime() > BACKUP_STALE_MS;
    // Отчётов не было ни разу: в разработке скриптов бэкапа нет («неизвестно»), в проде это авария
    const level: LifecycleHealthLevel = b.empty ? (isDevEnv() ? 'unknown' : 'critical') : stale || (lastDrill && !lastDrill.ok) ? 'critical' : lastFailed && (!lastSuccessAt || lastFailed.startedAt > lastSuccessAt) ? 'warning' : 'ok';
    return {
      level,
      lastSuccessAt,
      lastFailedAt: lastFailed && (!lastSuccessAt || lastFailed.startedAt > lastSuccessAt) ? lastFailed.startedAt : null,
      coveredDays: b.coverage.filter((c) => c.backup).length,
      repos,
      lastDrill,
    };
  }

  /** Отчёт скрипта бэкапа или учения: идемпотентно по (вид, репозиторий, метка). */
  async report(input: LifecycleBackupReportInput): Promise<{ id: string; created: boolean }> {
    const existing = await this.db.lifecycleBackupRun.findUnique({ where: { kind_repo_externalId: { kind: input.kind, repo: input.repo, externalId: input.externalId } }, select: { id: true } });
    const data = {
      status: input.status,
      startedAt: new Date(input.startedAt),
      finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
      bytes: input.bytes === null || input.bytes === undefined ? null : BigInt(input.bytes),
      details: (input.details ?? {}) as Prisma.InputJsonObject,
    };
    const row = await this.db.lifecycleBackupRun.upsert({
      where: { kind_repo_externalId: { kind: input.kind, repo: input.repo, externalId: input.externalId } },
      create: { kind: input.kind, repo: input.repo, externalId: input.externalId, ...data },
      update: { ...data, reportedAt: new Date() },
      select: { id: true },
    });
    this.cache.clear();
    return { id: row.id, created: !existing };
  }

  private backupDto(r: { id: string; kind: string; repo: string; status: string; startedAt: Date; finishedAt: Date | null; bytes: bigint | null; details: Prisma.JsonValue; reportedAt: Date }): LifecycleBackupRunDto {
    return {
      id: r.id,
      kind: r.kind as LifecycleBackupKind,
      repo: r.repo,
      status: r.status as LifecycleBackupStatus,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      bytes: r.bytes === null ? null : Number(r.bytes),
      details: (r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? r.details : null) as LifecycleBackupRunDto['details'],
      reportedAt: r.reportedAt.toISOString(),
    };
  }

  // ============================================================
  // Канарейка
  // ============================================================

  async canary(): Promise<LifecycleDataCanaryDto> {
    const runs = await this.db.lifecycleRun.findMany({ where: { kind: 'canary' }, orderBy: { startedAt: 'desc' }, take: 30 });
    return {
      runs: runs.map((r) => {
        const rep = (r.report ?? {}) as { policies?: number; findings?: Array<{ store: string; kind: string; count: number }>; unseeded?: string[]; durationMs?: number };
        const findings = Array.isArray(rep.findings) ? rep.findings : [];
        return {
          id: r.id,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
          stores: typeof rep.policies === 'number' ? rep.policies : 0,
          findings: findings.reduce((a, f) => a + (typeof f.count === 'number' ? f.count : 1), 0),
          unseeded: Array.isArray(rep.unseeded) ? rep.unseeded.length : 0,
          durationMs: typeof rep.durationMs === 'number' ? rep.durationMs : null,
          details: findings.slice(0, 20).map((f) => ({ store: String(f.store), kind: String(f.kind) })),
        };
      }),
    };
  }

  private async lastCanary(): Promise<{ at: string; ok: boolean; findings: number; unseeded: number } | null> {
    const r = await this.db.lifecycleRun.findFirst({ where: { kind: 'canary', status: { in: ['done', 'failed'] } }, orderBy: { startedAt: 'desc' } });
    if (!r) return null;
    const rep = (r.report ?? {}) as { ok?: boolean; findings?: unknown[]; unseeded?: unknown[] };
    return {
      at: r.startedAt.toISOString(),
      ok: r.status === 'done' && rep.ok !== false,
      findings: Array.isArray(rep.findings) ? rep.findings.length : 0,
      unseeded: Array.isArray(rep.unseeded) ? rep.unseeded.length : 0,
    };
  }

  // ============================================================
  // Отчёт неиспользуемых индексов (команда `lifecycle.indexes.report`)
  // ============================================================

  async unusedIndexes(): Promise<LifecycleUnusedIndexDto[]> {
    const rows = await this.db.$queryRaw<Array<{ table: string; index: string; bytes: bigint; scans: bigint }>>`
      SELECT s.schemaname || '.' || s.relname AS table, s.indexrelname AS index,
             pg_relation_size(s.indexrelid)::bigint AS bytes, s.idx_scan::bigint AS scans
        FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
       ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 100`;
    return rows.map((r) => ({ table: r.table, index: r.index, bytes: Number(r.bytes), scans: Number(r.scans) }));
  }
}
