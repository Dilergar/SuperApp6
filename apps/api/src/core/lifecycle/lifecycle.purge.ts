import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIFECYCLE_FOREVER,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_PENDING_KEYS,
  LIFECYCLE_POLICY_IDS,
  LIFECYCLE_QUEUE,
  lifecyclePolicy,
  resolveLifecycleRetention,
  type LifecyclePolicy,
  type LifecycleStopReason,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { LifecycleHealth } from './lifecycle.health';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecycleBlastRadiusError, LifecyclePurgeHandlerRegistry, type LifecyclePurgeHandler } from './lifecycle.purge.registry';
import { LifecycleRuns, type LifecycleRunRow } from './lifecycle.runs';
import { LifecycleSettings } from './lifecycle.settings';
import { LifecycleOverrides } from './lifecycle.overrides';
import {
  deleteBatchSql,
  estimateSql,
  isQueryTimeout,
  lifecycleRules,
  lifecycleTableOf,
  lifecycleTenantScopeSql,
  lockHoldsShared,
  releasableIds,
  ruleCutoff,
  type LifecycleRule,
  type LifecycleTable,
} from './lifecycle.sql';
import { inPurgeWindow, msUntilPurgeWindow } from './lifecycle.window';

type Tx = Prisma.TransactionClient;

/** Полезная нагрузка джоба прогона (только id и флаги — правило Sidekiq). */
interface PurgePayload {
  policyId: string;
  runId: string;
  dryRun?: boolean;
  /** Подтверждённый человеком прогон сверх подозрительного объёма */
  force?: boolean;
  /** Вне окна (дев-полигон, стирание субъекта) */
  anytime?: boolean;
}

/** Состояние продолжения прогона — в `report` строки прогона. */
interface PurgeState {
  rule?: number;
  batch?: number;
  timeouts?: number;
  /** Курсор keyset шага модуля */
  cursor?: string | null;
}

type Outcome = 'done' | 'stopped' | 'continue' | 'unhealthy' | 'window';

/** Способ принуждения политики раннером (или null — раннер её не ведёт). */
export type LifecyclePurgeMode = { kind: 'generic'; table: LifecycleTable; rules: LifecycleRule[] } | { kind: 'handler'; key: string; handler: LifecyclePurgeHandler };

/**
 * Раннер сроков хранения (plan §6.1): джоб `lifecycle.purge` на политику реестра с
 * `enforcement: batched_delete`. Общая пачка — SQL из реестра и схемы (старейшие строки
 * правила, `FOR UPDATE SKIP LOCKED`, `NOT EXISTS (заморозка)` в самом DELETE, таймауты
 * `SET LOCAL`); свой шаг модуля — `LifecyclePurgeHandlerRegistry` (корзины, файлы, джобы).
 *
 * Страховки (уроки Atlassian 2022, GitLab 2017, Google/UniSuper 2024):
 *  - окно 01:00–06:00 Алматы; вне окна прогон ждёт открытия;
 *  - здоровье БД перед каждой пачкой (реплики, архив WAL, VACUUM таблицы, темп WAL,
 *    ожидания блокировок, цикл событий) — плохо → пауза, прогресс сохранён;
 *  - пачка AIMD: укладывается в 250 мс — растёт на 10 %, нет — делится пополам;
 *  - ожидание считается ДО первой пачки: больше доли живых строк таблицы — стоп до
 *    подтверждения человеком; факт обогнал ожидание на 20 % — стоп и тревога;
 *  - кэп строк за прогон — хвост следующей ночью; dry-run — только счёт.
 */
/** Проба «у политики есть условие организации» — SQL строится, но не исполняется. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class LifecyclePurgeRunner implements OnModuleInit {
  private readonly logger = new Logger(LifecyclePurgeRunner.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly health: LifecycleHealth,
    private readonly runs: LifecycleRuns,
    private readonly metrics: LifecycleMetrics,
    private readonly settings: LifecycleSettings,
    private readonly overrides: LifecycleOverrides,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(LIFECYCLE_JOBS.purge, (payload) => this.handle(payload as unknown as PurgePayload), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 2,
      leaseMs: LIFECYCLE_LIMITS.jobBudgetMs + 120_000,
      maxAttempts: 5,
      onDiscard: async (payload, info) => {
        const runId = String((payload as Record<string, unknown>).runId ?? '');
        if (runId) await this.runs.finish(runId, 'failed', { report: { error: info.error.slice(0, 300) } });
      },
    });
  }

  /** Как раннер ведёт политику; `null` — не ведёт (срок вечен, шаг не зарегистрирован и т.п.). */
  mode(policy: LifecyclePolicy): LifecyclePurgeMode | null {
    const en = policy.enforcement;
    // Секционированный журнал: общий срок — сброс партиции (функции владельца), а срок,
    // выбранный организацией короче, — пачками её строк внутри партиций
    if (en.kind === 'drop_partition') {
      const table = lifecycleTableOf(policy);
      return table && policy.retention.tenantConfigurable && lifecycleTenantScopeSql(policy, table, NIL_UUID) ? { kind: 'generic', table, rules: [] } : null;
    }
    if (en.kind !== 'batched_delete') return null;
    if (en.handler) {
      const handler = this.handlers.get(en.handler);
      return handler ? { kind: 'handler', key: en.handler, handler } : null;
    }
    const table = lifecycleTableOf(policy);
    const rules = lifecycleRules(policy);
    // Срок, выбранный организациями, — правила по организациям (читаются на каждом заходе)
    const tenant = !!table && !!policy.retention.tenantConfigurable && !!lifecycleTenantScopeSql(policy, table, NIL_UUID);
    return table && (rules.length || tenant) ? { kind: 'generic', table, rules } : null;
  }

  /**
   * Как раннер ведёт политику СЕЙЧАС: к реестру добавляется срок, заданный командой Кабинета
   * (`lifecycle.retention.override`), — политика «вечно» с таким сроком становится ведомой.
   */
  async modeOf(policy: LifecyclePolicy): Promise<LifecyclePurgeMode | null> {
    const base = this.mode(policy);
    if (base) return base;
    const en = policy.enforcement;
    if (en.kind !== 'batched_delete' || en.handler) return null;
    const ov = await this.overrides.get(policy.id);
    const table = lifecycleTableOf(policy);
    return ov?.days && table ? { kind: 'generic', table, rules: [] } : null;
  }

  /** Правила прогона: статические реестра (срок — с переопределением Кабинета) + по организациям с конечным выбранным сроком. */
  private async rulesOf(policy: LifecyclePolicy, mode: Extract<LifecyclePurgeMode, { kind: 'generic' }>): Promise<LifecycleRule[]> {
    const en = policy.enforcement;
    let base = mode.rules;
    const ov = await this.overrides.get(policy.id);
    if (ov?.days && en.kind === 'batched_delete') {
      // Срок команды не ниже пола закона (проверила команда) — главное правило берёт его
      const floor = policy.retention.floorDays;
      const days = typeof floor === 'number' && ov.days < floor ? floor : ov.days;
      base = [{ index: 0, column: en.column, days, ...(en.filter ? { filter: en.filter } : {}) }, ...base.filter((r) => r.index !== 0)];
    }
    if (!policy.retention.tenantConfigurable || (en.kind !== 'batched_delete' && en.kind !== 'drop_partition')) return base;
    if (!lifecycleTenantScopeSql(policy, mode.table, NIL_UUID)) return base;
    const tenant = (await this.settings.tenantRetentions(policy)).map((r, i) => ({
      index: 1000 + i,
      column: en.column,
      days: r.days,
      ...(en.kind === 'batched_delete' && en.filter ? { filter: en.filter } : {}),
      workspaceId: r.workspaceId,
    }));
    return [...base, ...tenant];
  }

  /** Политики, которые раннер ведёт по ночам (без ждущих этапа и выключенных). */
  async enforceablePolicies(): Promise<LifecyclePolicy[]> {
    const out: LifecyclePolicy[] = [];
    for (const id of LIFECYCLE_POLICY_IDS) {
      const p = lifecyclePolicy(id)!;
      if (p.pause || (p.enforcement.kind !== 'batched_delete' && p.enforcement.kind !== 'drop_partition')) continue;
      if (p.enforcement.kind === 'batched_delete' && p.enforcement.handler && LIFECYCLE_PENDING_KEYS[p.enforcement.handler]) continue;
      if (await this.modeOf(p)) out.push(p);
    }
    return out;
  }

  /**
   * Поставить прогон политики. Строка прогона и джоб — одной транзакцией; живой джоб той
   * же политики уже есть — ничего не ставится (`queued: false`).
   */
  async schedule(policyId: string, opts: { dryRun?: boolean; force?: boolean; anytime?: boolean } = {}): Promise<{ runId: string | null; queued: boolean }> {
    const policy = lifecyclePolicy(policyId);
    if (!policy || !(await this.modeOf(policy))) throw new Error(`lifecycle purge: policy "${policyId}" is not enforceable by the runner`);
    const NOT_QUEUED = Symbol('not-queued');
    try {
      const runId = await this.db.$transaction(async (tx) => {
        const id = await this.runs.start(tx, { kind: 'purge', policyId, dryRun: opts.dryRun, report: { force: !!opts.force, anytime: !!opts.anytime } });
        const payload: PurgePayload = { policyId, runId: id, ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.force ? { force: true } : {}), ...(opts.anytime ? { anytime: true } : {}) };
        const { inserted } = await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.purge, payload: payload as unknown as Record<string, unknown>, uniqueKey: `purge:${policyId}` });
        if (!inserted) throw NOT_QUEUED;
        return id;
      });
      return { runId, queued: true };
    } catch (err) {
      if (err === NOT_QUEUED) return { runId: null, queued: false };
      throw err;
    }
  }

  /** Ночной план: прогон каждой ведомой политики. Возвращает число поставленных. */
  async planNightly(): Promise<number> {
    let queued = 0;
    for (const p of await this.enforceablePolicies()) {
      try {
        if ((await this.schedule(p.id)).queued) queued++;
      } catch (err) {
        this.logger.error(`nightly purge plan: ${p.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return queued;
  }

  /**
   * Прогон сейчас в этом процессе — без очереди, окна и пауз (дев-полигон, сьюты): здоровье
   * «плохо» — прогон остаётся `running`, ответ говорит почему.
   */
  async runInline(policyId: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<{ run: LifecycleRunRow; outcome: Outcome; healthReason?: string | null }> {
    const policy = lifecyclePolicy(policyId);
    if (!policy || !(await this.modeOf(policy))) throw new Error(`lifecycle purge: policy "${policyId}" is not enforceable by the runner`);
    const runId = await this.runs.start(null, { kind: 'purge', policyId, dryRun: opts.dryRun, report: { force: !!opts.force, anytime: true, inline: true } });
    const res = await this.execute({ policyId, runId, dryRun: opts.dryRun, force: opts.force, anytime: true }, Number.POSITIVE_INFINITY);
    // Прогон в процессе не продолжает никто — прерванный здоровьем закрывается, а не висит «running»
    if (res.outcome !== 'done' && res.outcome !== 'stopped') {
      await this.runs.finish(runId, 'stopped', { stoppedReason: 'cancelled', report: { inlineOutcome: res.outcome, healthReason: res.healthReason ?? null } });
    }
    return { run: (await this.runs.get(runId))!, outcome: res.outcome, healthReason: res.healthReason ?? null };
  }

  // ---------------------------------------------------------------- джоб

  private async handle(payload: PurgePayload): Promise<void> {
    if (!payload?.policyId || !payload?.runId) throw new JobDiscardError('lifecycle.purge: policyId and runId are required');
    if (!payload.anytime && !payload.dryRun) {
      const wait = msUntilPurgeWindow();
      if (wait > 0) throw new JobSnoozeError(wait, 'outside the retention window');
    }
    const res = await this.execute(payload, Date.now() + LIFECYCLE_LIMITS.jobBudgetMs);
    if (res.outcome === 'continue') throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'budget spent, continuing');
    if (res.outcome === 'unhealthy') {
      this.metrics.purgeSnoozed(res.healthReason ?? 'timeouts');
      throw new JobSnoozeError(LIFECYCLE_LIMITS.healthSnoozeMs, `database unhealthy: ${res.healthReason ?? 'timeouts'}`);
    }
    if (res.outcome === 'window') throw new JobSnoozeError(msUntilPurgeWindow(), 'retention window closed');
  }

  // ---------------------------------------------------------------- исполнение

  private async execute(p: PurgePayload, deadline: number): Promise<{ outcome: Outcome; healthReason?: string | null }> {
    const policy = lifecyclePolicy(p.policyId);
    if (!policy) throw new JobDiscardError(`lifecycle.purge: unknown policy ${p.policyId}`);
    let run = await this.runs.get(p.runId);
    if (!run) throw new JobDiscardError(`lifecycle.purge: run ${p.runId} is gone`);
    if (run.status !== 'running') return { outcome: 'done' };
    if (policy.pause || (await this.overrides.get(policy.id))?.paused) return this.stop(run, 'paused');
    const mode = await this.modeOf(policy);
    if (!mode) return this.stop(run, 'handler_missing');

    // Ожидание — до первой пачки: и кэп радиуса, и отчёт dry-run, и сверка «факт/ожидание»
    if (run.expectedRows === null) {
      const expected = await this.estimate(policy, mode);
      if (expected !== null) {
        await this.runs.setExpected(run.id, expected);
        if (!p.force && !p.dryRun && mode.kind === 'generic' && (await this.suspicious(mode.table, expected))) {
          this.logger.error(`purge ${policy.id}: ${expected} rows due looks like a broken retention — stopped until confirmed`);
          return this.stop(run, 'blast_radius', { expected });
        }
      }
      run = (await this.runs.get(run.id))!;
    }
    if (p.dryRun) {
      await this.runs.finish(run.id, 'done', { report: { expected: run.expectedRows } });
      return { outcome: 'done' };
    }

    const state: PurgeState = { rule: 0, batch: LIFECYCLE_LIMITS.batchStart, timeouts: 0, ...(run.report as PurgeState) };
    const rules = mode.kind === 'generic' ? await this.rulesOf(policy, mode) : [];
    let rows = run.rows;
    const tableName = mode.kind === 'generic' ? mode.table.name : null;
    for (;;) {
      if (Date.now() > deadline) {
        await this.runs.saveState(run.id, state as Record<string, unknown>);
        return { outcome: 'continue' };
      }
      if (!p.anytime && !inPurgeWindow()) {
        await this.runs.saveState(run.id, state as Record<string, unknown>);
        return { outcome: 'window' };
      }
      const verdict = await this.health.check(tableName);
      if (!verdict.ok) {
        await this.runs.saveState(run.id, { ...state, lastHealth: verdict.reason });
        return { outcome: 'unhealthy', healthReason: verdict.reason };
      }
      if (rows >= LIFECYCLE_LIMITS.maxRowsPerRun) return this.stop(run, 'max_rows');

      const limit = Math.min(state.batch ?? LIFECYCLE_LIMITS.batchStart, LIFECYCLE_LIMITS.maxRowsPerRun - rows);
      const started = Date.now();
      let n = 0;
      let more = true;
      try {
        if (mode.kind === 'generic') {
          const rule = rules[state.rule ?? 0];
          if (!rule) break;
          const cutoff = ruleCutoff(rule, new Date());
          n = await this.db.$transaction(async (tx) => {
            await lockHoldsShared(tx);
            await this.setBatchTimeouts(tx);
            const deleted = await tx.$executeRaw(deleteBatchSql(policy, mode.table, rule, cutoff, limit));
            if (deleted) await this.runs.progress(tx, run!.id, deleted);
            return deleted;
          });
          // Правило исчерпано (SKIP LOCKED оставляет занятые строки следующей ночи)
          if (n < limit) state.rule = (state.rule ?? 0) + 1;
          more = state.rule! < rules.length;
        } else {
          const res = await mode.handler.purgeBatch({
            policy,
            runId: run.id,
            cutoff: await this.handlerCutoff(policy),
            limit,
            cursor: state.cursor ?? null,
            force: !!p.force,
            releasable: (tx: Tx, ids: readonly string[]) => releasableIds(tx, policy, ids),
          });
          n = res.rows;
          more = res.more;
          if (res.cursor !== undefined) state.cursor = res.cursor;
          if (n) await this.runs.progress(null, run.id, n);
        }
        state.timeouts = 0;
      } catch (err) {
        if (err instanceof LifecycleBlastRadiusError) {
          this.logger.error(`purge ${policy.id}: ${err.message} — stopped until confirmed`);
          return this.stop(run, 'blast_radius', { due: err.due, threshold: err.threshold });
        }
        if (!isQueryTimeout(err)) throw err;
        state.timeouts = (state.timeouts ?? 0) + 1;
        state.batch = Math.max(LIFECYCLE_LIMITS.batchMin, Math.floor((state.batch ?? LIFECYCLE_LIMITS.batchStart) * LIFECYCLE_LIMITS.batchShrink));
        this.metrics.purgeTimeout(policy.id);
        if (state.timeouts >= LIFECYCLE_LIMITS.batchTimeoutStreak) {
          await this.runs.saveState(run.id, { ...state, timeouts: 0 });
          return { outcome: 'unhealthy', healthReason: 'timeouts' };
        }
        continue;
      }
      const elapsed = Date.now() - started;
      rows += n;
      this.metrics.purgeBatch(policy.id, n, elapsed);
      // AIMD: цель 250 мс на пачку
      state.batch =
        elapsed <= LIFECYCLE_LIMITS.batchTargetMs
          ? Math.min(LIFECYCLE_LIMITS.batchMax, Math.ceil((state.batch ?? LIFECYCLE_LIMITS.batchStart) * LIFECYCLE_LIMITS.batchGrow))
          : Math.max(LIFECYCLE_LIMITS.batchMin, Math.floor((state.batch ?? LIFECYCLE_LIMITS.batchStart) * LIFECYCLE_LIMITS.batchShrink));
      // Факт обогнал ожидание — срок, часы или фильтр сломались посреди прогона
      const expected = run.expectedRows;
      if (expected !== null && rows > expected * (1 + LIFECYCLE_LIMITS.overrunShare) + LIFECYCLE_LIMITS.batchMax) {
        this.logger.error(`purge ${policy.id}: ${rows} rows deleted, ${expected} expected — stopped`);
        return this.stop(run, 'overrun', { expected, rows });
      }
      if (!more) break;
    }
    await this.runs.finish(run.id, 'done', { report: { rule: state.rule, batch: state.batch } });
    return { outcome: 'done' };
  }

  private async stop(run: LifecycleRunRow, reason: LifecycleStopReason, report: Record<string, unknown> = {}): Promise<{ outcome: Outcome }> {
    await this.runs.finish(run.id, 'stopped', { stoppedReason: reason, report });
    if (reason === 'blast_radius' || reason === 'overrun') this.metrics.purgeHalted(run.policyId ?? 'unknown', reason);
    return { outcome: 'stopped' };
  }

  /** Срок политики для шага модуля; вечный — окно решает модуль (корзина 30 дней). */
  private async handlerCutoff(policy: LifecyclePolicy): Promise<Date | null> {
    const ov = await this.overrides.get(policy.id);
    const { days } = resolveLifecycleRetention({ policy });
    const floor = policy.retention.floorDays;
    const effective = ov?.days ? (typeof floor === 'number' && ov.days < floor ? floor : ov.days) : days;
    return effective === LIFECYCLE_FOREVER || effective === 0 ? null : new Date(Date.now() - effective * 86_400_000);
  }

  private async estimate(policy: LifecyclePolicy, mode: LifecyclePurgeMode): Promise<number | null> {
    if (mode.kind === 'handler') {
      if (!mode.handler.estimate) return null;
      return mode.handler.estimate({ policy, cutoff: await this.handlerCutoff(policy) });
    }
    let total = 0;
    const now = new Date();
    for (const rule of await this.rulesOf(policy, mode)) {
      const [row] = await this.db.$queryRaw<Array<{ n: bigint }>>(estimateSql(policy, mode.table, rule, ruleCutoff(rule, now), LIFECYCLE_LIMITS.maxRowsPerRun + 1));
      total += Number(row?.n ?? 0);
    }
    return total;
  }

  /** Ожидание больше доли живых строк таблицы (оценка планировщика) — подозрительно. */
  private async suspicious(table: LifecycleTable, expected: number): Promise<boolean> {
    if (expected < LIFECYCLE_LIMITS.minSuspiciousRows) return false;
    const [row] = await this.db.$queryRaw<Array<{ n: number }>>`
      SELECT GREATEST(c.reltuples, 0)::float8 AS n FROM pg_class c WHERE c.oid = to_regclass(${table.name})`;
    const live = Number(row?.n ?? 0);
    return live <= 0 || expected > live * LIFECYCLE_LIMITS.suspiciousShare;
  }

  private async setBatchTimeouts(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LIFECYCLE_LIMITS.batchLockTimeoutMs}ms`}, true), set_config('statement_timeout', ${`${LIFECYCLE_LIMITS.batchStatementTimeoutMs}ms`}, true)`;
  }
}
