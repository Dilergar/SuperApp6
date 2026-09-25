import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { LIFECYCLE_FOREVER, lifecyclePolicy } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { AuditService } from '../audit/audit.service';
import { LifecycleMetrics } from './lifecycle.metrics';

const DAY_MS = 86_400_000;
/** Правила родителей меняет только миграция — кэш на процесс с коротким сроком. */
const SPEC_TTL_MS = 5 * 60_000;
/** Ожидание блокировки родителя внутри функции — 2 с; повторы с бэкоффом, потом пропуск. */
const LOCK_RETRIES = 5;
/** Сбросов за прогон на родителя: радиус поражения ошибочной настройки ограничен. */
const MAX_DROPS_PER_RUN = 12;
/** Потолок счётчика в деталях журнала безопасности (`detailCount`). */
const DETAIL_COUNT_MAX = 100_000_000;

/** Правило партиционированного родителя (`lifecycle_partition_specs`; пишет только миграция). */
export interface LifecyclePartitionSpec {
  /** schema.table */
  parent: string;
  column: string;
  period: 'day' | 'month';
  floorDays: number;
  requireArchive: boolean;
  aheadPeriods: number;
  policyId: string;
  dataClass: string;
  holdAware: boolean;
}

/** Лист партиционированного родителя. Границы — из имени (его даёт функция владельца). */
export interface LifecyclePartitionLeaf {
  name: string;
  from: Date;
  to: Date;
  /** Оборванный `DETACH … CONCURRENTLY` — доводится функцией сброса (FINALIZE) */
  detachPending: boolean;
}

/** Своё у родителя: срок из окружения движка-владельца и реакция на сброс листьев. */
export interface LifecyclePartitionOwner {
  /** Срок, мс. Нет — умолчание политики реестра (`retention.defaultDays`) */
  retentionMs?: () => number;
  /** После сброса (кэш «первого события» и т.п.); ошибка не отменяет сброс */
  onDropped?: (leaves: string[]) => Promise<void> | void;
}

/** Здоровье родителя — для метрик, дашборда «Данные» и verify-partitions. */
export interface LifecyclePartitionHealth {
  parent: string;
  leaves: number;
  /** Листья от текущего периода и дальше (текущий + будущие) */
  ahead: number;
  detachPending: number;
  hasDefault: boolean;
  oldestFrom: Date | null;
}

/** Ручка одного родителя — то, что видят движки-владельцы (analytics, idempotency, keys). */
export interface LifecycleParentPartitions {
  readonly parent: string;
  ensureFor(at: Date): Promise<string>;
  ensureAhead(now?: Date): Promise<string[]>;
  list(): Promise<LifecyclePartitionLeaf[]>;
  dropExpired(now?: Date): Promise<string[]>;
}

/** Родители со своими функциями владельца (core/audit): здоровье считаем, DDL — не наше. */
const FOREIGN_PARENTS: ReadonlyArray<{ parent: string; period: 'month' }> = [{ parent: 'public.security_events', period: 'month' }];

/**
 * Партиции ВСЕХ партиционированных журналов платформы — одна дверь (plan §5.3; закрывает
 * P1–P12 прежних трёх хелперов). DDL исполняют SECURITY DEFINER-функции владельца данных
 * (миграция `core_lifecycle`): роль приложения не владеет таблицами, пол срока, архив и
 * заморозки проверяет БАЗА.
 *
 *  - создание — `lifecycle_ensure_partition`: CREATE + CHECK границ + ATTACH (SHARE UPDATE
 *    EXCLUSIVE, не ACCESS EXCLUSIVE), DEFAULT-партиция запрещена, вперёд ≥ `aheadPeriods`;
 *  - сброс — `lifecycle_drop_partition`: только лист старше max(срок, пол, самый длинный срок
 *    организаций), ≤ 12 за прогон, «detach pending» доводится FINALIZE, заморозка держит;
 *  - блокировки — `lock_timeout 2 с` в функции + 5 повторов с бэкоффом, затем пропуск и метрика
 *    (обслуживание не встаёт в очередь за долгим запросом и не держит за собой вставки);
 *  - `ANALYZE` родителя после сброса и ночью (автовакуум родителей не анализирует);
 *  - поиск по одному id — только с подсказкой времени (`lifecycle.time-hint.ts`): иначе
 *    планировщик открывает все партиции.
 */
@Injectable()
export class LifecyclePartitions implements OnApplicationBootstrap {
  private readonly logger = new Logger(LifecyclePartitions.name);
  /** Листья, уже подтверждённые этим инстансом (`parent:leaf`) */
  private readonly known = new Set<string>();
  private readonly owners = new Map<string, LifecyclePartitionOwner>();
  private specCache: { at: number; specs: LifecyclePartitionSpec[] } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly metrics: LifecycleMetrics,
    private readonly audit: AuditService,
  ) {}

  /** Бут доделывает то, что ночной крон мог не успеть: листья вперёд у всех родителей. */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensureAheadAll().catch((err: unknown) => this.logger.error(`partitions on boot: ${errText(err)}`));
  }

  /** Движок-владелец объявляет свой срок и реакцию на сброс (в своём onModuleInit). */
  register(parent: string, owner: LifecyclePartitionOwner): void {
    this.owners.set(parent, owner);
  }

  /** Ручка родителя для движка-владельца. */
  forParent(parent: string): LifecycleParentPartitions {
    return {
      parent,
      ensureFor: (at) => this.ensureFor(parent, at),
      ensureAhead: (now) => this.ensureAhead(parent, now),
      list: () => this.list(parent),
      dropExpired: (now) => this.dropExpired(parent, now),
    };
  }

  // ---------------------------------------------------------------- правила

  /** Правила родителей: горячий путь — из кэша, обслуживание и здоровье — `fresh` из БД. */
  async specs(fresh = false): Promise<LifecyclePartitionSpec[]> {
    if (!fresh && this.specCache && Date.now() - this.specCache.at < SPEC_TTL_MS) return this.specCache.specs;
    const rows = await runInternal(() => this.db.lifecyclePartitionSpec.findMany({ orderBy: { parent: 'asc' } }));
    const specs = rows.map((r) => ({
      parent: r.parent,
      column: r.column,
      period: r.period === 'day' ? ('day' as const) : ('month' as const),
      floorDays: r.floorDays,
      requireArchive: r.requireArchive,
      aheadPeriods: r.aheadPeriods,
      policyId: r.policyId,
      dataClass: r.dataClass,
      holdAware: r.holdAware,
    }));
    this.specCache = { at: Date.now(), specs };
    return specs;
  }

  async spec(parent: string): Promise<LifecyclePartitionSpec> {
    // Промах кэша — одна перечитка: правило могла добавить миграция после старта инстанса
    const spec = (await this.specs()).find((s) => s.parent === parent) ?? (await this.specs(true)).find((s) => s.parent === parent);
    if (!spec) throw new Error(`lifecycle partitions: ${parent} is not a registered partitioned parent`);
    return spec;
  }

  // ---------------------------------------------------------------- создание

  /** Лист периода момента `at` (идемпотентно; кэш имён на процесс). */
  async ensureFor(parent: string, at: Date): Promise<string> {
    const spec = await this.spec(parent);
    const leaf = leafName(spec.parent, spec.period, at);
    const key = `${parent}:${leaf}`;
    if (this.known.has(key)) return leaf;
    await this.withLockRetry(() =>
      runInternal(() => this.db.$queryRaw<Array<{ leaf: string }>>`SELECT lifecycle_ensure_partition(${parent}, ${at}::timestamptz) AS leaf`),
    );
    // Кэш — только текущий период и будущие: их сброс по сроку невозможен (пол ≥ периода), а
    // прошедший лист мог сбросить соседний инстанс — запомненное имя тогда лгало бы, и повтор
    // «нет партиции → завести → вставить» падал бы снова
    if (nextPeriod(spec.period, periodStart(spec.period, at)).getTime() > Date.now()) this.known.add(key);
    return leaf;
  }

  /** Текущий период и `aheadPeriods − 1` следующих. */
  async ensureAhead(parent: string, now = new Date()): Promise<string[]> {
    const spec = await this.spec(parent);
    const out: string[] = [];
    let at = periodStart(spec.period, now);
    for (let i = 0; i < spec.aheadPeriods; i++) {
      out.push(await this.ensureFor(parent, at));
      at = nextPeriod(spec.period, at);
    }
    return out;
  }

  async ensureAheadAll(now = new Date()): Promise<void> {
    for (const spec of await this.specs(true)) {
      try {
        await this.ensureAhead(spec.parent, now);
      } catch (err) {
        this.metrics.maintenanceError(spec.parent, 'ensure');
        this.logger.error(`${spec.parent}: partitions ahead not created: ${errText(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------- листья

  async list(parent: string): Promise<LifecyclePartitionLeaf[]> {
    const spec = (await this.specs()).find((s) => s.parent === parent);
    const period = spec?.period ?? FOREIGN_PARENTS.find((f) => f.parent === parent)?.period;
    if (!period) throw new Error(`lifecycle partitions: ${parent} is not a known partitioned parent`);
    const [schema, table] = splitParent(parent);
    const rows = await runInternal(() =>
      this.db.$queryRaw<Array<{ name: string; pending: boolean }>>`
        SELECT c.relname AS name, i.inhdetachpending AS pending
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = ${schema} AND p.relname = ${table}
        ORDER BY c.relname`,
    );
    const out: LifecyclePartitionLeaf[] = [];
    for (const r of rows) {
      const from = leafStart(table, period, r.name);
      if (!from) continue;
      out.push({ name: r.name, from, to: nextPeriod(period, from), detachPending: r.pending });
    }
    return out;
  }

  // ---------------------------------------------------------------- сброс

  /**
   * Срок родителя в мс: срок владельца или умолчание реестра, не короче пола (правило
   * миграции и `floorDays` реестра), у настраиваемых организацией — не короче САМОГО
   * длинного выбранного срока (партиция общая: короче сроки добирает раннер purge
   * построчно). `null` — хранить вечно.
   */
  async retentionMs(spec: LifecyclePartitionSpec): Promise<number | null> {
    const policy = lifecyclePolicy(spec.policyId);
    const owner = this.owners.get(spec.parent);
    let ms: number;
    if (owner?.retentionMs) ms = owner.retentionMs();
    else if (!policy || policy.retention.defaultDays === LIFECYCLE_FOREVER) return null;
    else ms = policy.retention.defaultDays * DAY_MS;
    if (policy?.retention.tenantConfigurable) {
      const [t] = await runInternal(() =>
        this.db.$queryRaw<Array<{ forever: boolean | null; max_days: number | null }>>`
          SELECT bool_or(days IS NULL) AS forever, max(days)::int AS max_days
          FROM lifecycle_settings WHERE data_class = ${policy.dataClass}`,
      );
      if (t?.forever) return null;
      if (t?.max_days) ms = Math.max(ms, t.max_days * DAY_MS);
    }
    const floor = policy?.retention.floorDays;
    if (floor === LIFECYCLE_FOREVER) return null;
    return Math.max(ms, spec.floorDays * DAY_MS, (floor ?? 0) * DAY_MS);
  }

  /** Сбросить листья, чья ВЕРХНЯЯ граница старше срока. Каждый лист — своя попытка. */
  async dropExpired(parent: string, now = new Date()): Promise<string[]> {
    const spec = await this.spec(parent);
    const ms = await this.retentionMs(spec);
    if (ms === null) return [];
    const cutoff = now.getTime() - ms;
    const due = (await this.list(parent))
      .filter((l) => l.to.getTime() <= cutoff)
      .sort((a, b) => a.from.getTime() - b.from.getTime())
      .slice(0, MAX_DROPS_PER_RUN);
    const dropped: string[] = [];
    const [schema] = splitParent(parent);
    for (const l of due) {
      try {
        // Оценка строк листа до сброса (каталог, не count(*): лист журнала — сотни миллионов строк)
        const [est] = await runInternal(() =>
          this.db.$queryRaw<Array<{ n: number }>>`SELECT GREATEST(c.reltuples, 0)::float8 AS n FROM pg_class c WHERE c.oid = to_regclass(${`${schema}.${l.name}`})`,
        );
        const [res] = await this.withLockRetry(() =>
          runInternal(() => this.db.$queryRaw<Array<{ dropped: boolean }>>`SELECT lifecycle_drop_partition(${parent}, ${l.name}) AS dropped`),
        );
        if (res?.dropped) {
          dropped.push(l.name);
          // Доказательство сброса (NIST 800-88: удаление, которое нельзя доказать, для регулятора не
          // случилось) — событие журнала безопасности; сбой записи сброс не отменяет, но виден
          await this.audit
            .record(null, {
              key: 'lifecycle.partition.dropped',
              actor: { kind: 'system' },
              target: { type: 'lifecycle_policy', id: spec.policyId },
              details: { policy: spec.policyId, partition: `${schema}.${l.name}`, rows: Math.min(DETAIL_COUNT_MAX, Math.round(Number(est?.n ?? 0))), held: 0 },
            })
            .catch((err: unknown) => this.logger.error(`${parent}: partition ${l.name} dropped, but its audit event failed: ${errText(err)}`));
        }
      } catch (err) {
        this.metrics.maintenanceError(parent, 'drop');
        this.logger.error(`${parent}: partition ${l.name} was not dropped: ${errText(err)}`);
      }
      this.known.delete(`${parent}:${l.name}`);
    }
    if (dropped.length) {
      this.metrics.droppedLeaves(parent, dropped.length);
      this.logger.log(`${parent}: dropped by retention ${dropped.join(', ')}`);
      await this.analyze(parent);
      try {
        await this.owners.get(parent)?.onDropped?.(dropped);
      } catch (err) {
        this.logger.warn(`${parent}: onDropped hook failed: ${errText(err)}`);
      }
    }
    return dropped;
  }

  /** ANALYZE родителя функцией владельца (планировщик оценивает по родителю). */
  async analyze(parent: string): Promise<void> {
    try {
      await runInternal(() => this.db.$queryRaw`SELECT lifecycle_analyze_partitioned(${parent})`);
    } catch (err) {
      this.metrics.maintenanceError(parent, 'analyze');
      this.logger.warn(`${parent}: analyze failed: ${errText(err)}`);
    }
  }

  // ---------------------------------------------------------------- здоровье и ночной прогон

  async health(now = new Date()): Promise<LifecyclePartitionHealth[]> {
    const parents = [...(await this.specs(true)).map((s) => ({ parent: s.parent, period: s.period })), ...FOREIGN_PARENTS];
    const out: LifecyclePartitionHealth[] = [];
    for (const { parent, period } of parents) {
      try {
        const leaves = await this.list(parent);
        const current = periodStart(period, now).getTime();
        const [schema, table] = splitParent(parent);
        const [d] = await runInternal(() =>
          this.db.$queryRaw<Array<{ has_default: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_partitioned_table pt
              JOIN pg_class p ON p.oid = pt.partrelid JOIN pg_namespace n ON n.oid = p.relnamespace
              WHERE n.nspname = ${schema} AND p.relname = ${table} AND pt.partdefid <> 0
            ) AS has_default`,
        );
        const h: LifecyclePartitionHealth = {
          parent,
          leaves: leaves.length,
          ahead: leaves.filter((l) => l.from.getTime() >= current).length,
          detachPending: leaves.filter((l) => l.detachPending).length,
          hasDefault: !!d?.has_default,
          oldestFrom: leaves.length ? leaves.reduce((m, l) => (l.from < m ? l.from : m), leaves[0].from) : null,
        };
        this.metrics.health(parent, h);
        out.push(h);
      } catch (err) {
        this.metrics.maintenanceError(parent, 'health');
        this.logger.error(`${parent}: partition health failed: ${errText(err)}`);
      }
    }
    return out;
  }

  /** Ночной прогон: вперёд, сброс по сроку, ANALYZE, здоровье → метрики. */
  async maintain(now = new Date()): Promise<{ dropped: Record<string, string[]>; health: LifecyclePartitionHealth[] }> {
    const dropped: Record<string, string[]> = {};
    for (const spec of await this.specs(true)) {
      try {
        await this.ensureAhead(spec.parent, now);
      } catch (err) {
        this.metrics.maintenanceError(spec.parent, 'ensure');
        this.logger.error(`${spec.parent}: partitions ahead not created: ${errText(err)}`);
      }
      try {
        dropped[spec.parent] = await this.dropExpired(spec.parent, now);
      } catch (err) {
        this.metrics.maintenanceError(spec.parent, 'drop');
        this.logger.error(`${spec.parent}: retention failed: ${errText(err)}`);
      }
      if (!dropped[spec.parent]?.length) await this.analyze(spec.parent);
    }
    const health = await this.health(now);
    for (const h of health) {
      if (h.ahead < 2) this.logger.error(`${h.parent}: only ${h.ahead} partition(s) from the current period on — inserts are about to fail`);
      if (h.hasDefault) this.logger.error(`${h.parent}: has a DEFAULT partition — forbidden`);
    }
    return { dropped, health };
  }

  // ---------------------------------------------------------------- утилиты

  /** «no partition of relation» — период не заведён: завести и повторить один раз. */
  static isMissingPartition(err: unknown): boolean {
    return /no partition of relation/i.test(errText(err));
  }

  /** Блокировка родителя не далась за 2 с — повторить с бэкоффом (5 раз), затем бросить. */
  private async withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isLockTimeout(err) || attempt >= LOCK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.floor(Math.random() * 200)));
      }
    }
  }
}

// ---------------------------------------------------------------- периоды и имена (UTC)

const pad = (n: number) => String(n).padStart(2, '0');

function splitParent(parent: string): [string, string] {
  const [schema, table] = parent.split('.');
  if (!schema || !table) throw new Error(`lifecycle partitions: parent must be schema.table, got ${parent}`);
  return [schema, table];
}

function periodStart(period: 'day' | 'month', at: Date): Date {
  return period === 'month'
    ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
    : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function nextPeriod(period: 'day' | 'month', start: Date): Date {
  return period === 'month'
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
}

/** Имя листа = `<table>_YYYY_MM` (месяц) | `<table>_YYYY_MM_DD` (день) — как у функции владельца. */
function leafName(parent: string, period: 'day' | 'month', at: Date): string {
  const [, table] = splitParent(parent);
  const s = periodStart(period, at);
  const ym = `${s.getUTCFullYear()}_${pad(s.getUTCMonth() + 1)}`;
  return period === 'month' ? `${table}_${ym}` : `${table}_${ym}_${pad(s.getUTCDate())}`;
}

function leafStart(table: string, period: 'day' | 'month', name: string): Date | null {
  if (!name.startsWith(`${table}_`)) return null;
  const m = (period === 'month' ? /^(\d{4})_(\d{2})$/ : /^(\d{4})_(\d{2})_(\d{2})$/).exec(name.slice(table.length + 1));
  if (!m) return null;
  return period === 'month' ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function isLockTimeout(err: unknown): boolean {
  return /lock timeout|55P03|could not obtain lock/i.test(errText(err));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
