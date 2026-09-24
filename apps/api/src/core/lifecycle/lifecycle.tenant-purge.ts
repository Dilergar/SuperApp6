import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_PENDING_KEYS,
  LIFECYCLE_QUEUE,
  lifecyclePolicy,
  lifecycleTenantPurgePlan,
  type LifecycleTenantPurgeStep,
  type WorkspaceId,
} from '@superapp/shared';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { conflict, notFound } from '../../shared/errors/api-error';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecycleTenantHeldError, LifecycleTenantHookRegistry, type LifecycleTenantPurgeContext } from './lifecycle.purge.registry';
import { LifecycleRuns } from './lifecycle.runs';
import { lifecycleTableOf, lockHoldsShared, releasableIds, tenantBatchSql, tenantEstimateSql, tenantHeld } from './lifecycle.sql';

interface TenantPurgePayload {
  workspaceId: string;
  runId: string;
}

/** Шаг каскада глазами предпросмотра (Atlassian 2022: сколько удалим — ДО удаления). */
export interface LifecycleTenantPreviewStep {
  key: string;
  kind: LifecycleTenantPurgeStep['kind'];
  policies: string[];
  /** Ожидаемые строки; `null` — шаг не умеет считать */
  rows: number | null;
  registered: boolean;
}

/**
 * Каскад окончательного удаления организации по плану реестра (`lifecycleTenantPurgePlan`):
 * хуки модулей и пачки по колонке организации, строка организации — последней (хук
 * `workspaces.row`: согласия, журнал, DELETE). Порядок и состав — из реестра, не из кода
 * модуля организаций.
 *
 * Шаги идемпотентны: пройденные копятся в `report.done` прогона, прерванный каскад
 * (снуз по бюджету, падение шага, рестарт) продолжает с первого непройденного. Хук, не
 * зарегистрированный в API, — СТОП каскада (fail-closed: иначе данные модуля пережили бы
 * организацию), кроме ключей, ждущих этапа (`LIFECYCLE_PENDING_KEYS`).
 *
 * Вид сущности проверяется по БД до первого шага (Atlassian 2022: скрипт принял id сайта
 * за id приложения и удалил 883 сайта) — живую организацию каскад не тронет.
 *
 * Заморозка (legal hold) любой области этой организации останавливает каскад ЦЕЛИКОМ
 * (`stopped: held`): проверка на старте, перед каждым шагом, между пачками хуков
 * (`checkpoint`) и под общим замком заморозок в финальной транзакции строки организации.
 */
@Injectable()
export class LifecycleTenantPurgeService implements OnModuleInit {
  private readonly logger = new Logger(LifecycleTenantPurgeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly hooks: LifecycleTenantHookRegistry,
    private readonly runs: LifecycleRuns,
    private readonly metrics: LifecycleMetrics,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(LIFECYCLE_JOBS.tenantPurge, (payload) => this.handle(payload as unknown as TenantPurgePayload), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 2,
      leaseMs: LIFECYCLE_LIMITS.jobBudgetMs + 120_000,
      maxAttempts: 10,
      onDiscard: async (payload, info) => {
        const runId = String((payload as Record<string, unknown>).runId ?? '');
        if (runId) await this.runs.finish(runId, 'failed', { report: { error: info.error.slice(0, 300) } });
      },
    });
  }

  /**
   * Организация существует и в архиве. Живую удалить нельзя ни ретеншном, ни командой —
   * сначала архив (обратимо), потом срок.
   */
  async assertArchivedWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
    if (!ws) throw notFound('workspace.notFound');
    if (ws.isActive) throw conflict('workspace.notArchived');
  }

  /** Организация под заморозкой — каскад её не трогает (ретеншн архива пропускает). */
  isHeld(workspaceId: WorkspaceId): Promise<boolean> {
    return this.db.$transaction((tx) => tenantHeld(tx, workspaceId));
  }

  /**
   * Поставить каскад в очередь (ретеншн архива, команда Кабинета). Уже идёт — вернуть его.
   * `tx` — транзакция вызывающего (команда Кабинета): строка прогона и джоб коммитятся с ней,
   * предпросмотр команды откатывает их вместе.
   */
  async schedule(workspaceId: WorkspaceId, tx?: Prisma.TransactionClient): Promise<{ runId: string; queued: boolean }> {
    await this.assertArchivedWorkspace(workspaceId);
    const running = await this.runs.findRunning('tenant_purge', { subjectId: workspaceId });
    if (running) return { runId: running.id, queued: false };
    const put = async (t: Prisma.TransactionClient) => {
      const id = await this.runs.start(t, { kind: 'tenant_purge', subjectType: 'workspace', subjectId: workspaceId, report: { done: [] } });
      await this.jobs.enqueue(t, { type: LIFECYCLE_JOBS.tenantPurge, payload: { workspaceId, runId: id }, uniqueKey: `tenant:${workspaceId}` });
      return id;
    };
    const runId = tx ? await put(tx) : await this.db.$transaction(put);
    return { runId, queued: true };
  }

  /**
   * Каскад целиком сейчас, без бюджета (дев-полигон, сьюты, уборка хвостов уже удалённых
   * организаций — `orphan: true`: строки организации нет, вид подтверждён тем, что id
   * найден в колонках «владелец = организация»).
   */
  async purgeNow(workspaceId: WorkspaceId, opts: { orphan?: boolean } = {}): Promise<void> {
    if (opts.orphan) {
      if (await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })) throw conflict('workspace.notArchived');
    } else {
      await this.assertArchivedWorkspace(workspaceId);
    }
    const running = await this.runs.findRunning('tenant_purge', { subjectId: workspaceId });
    const runId = running?.id ?? (await this.runs.start(null, { kind: 'tenant_purge', subjectType: 'workspace', subjectId: workspaceId, report: { done: [], ...(opts.orphan ? { orphan: true } : {}) } }));
    const outcome = await this.execute(runId, workspaceId, null, !!opts.orphan);
    if (outcome !== 'done') throw new Error(`tenant purge of ${workspaceId} did not finish (${outcome})`);
    const run = await this.runs.get(runId);
    if (run?.status === 'stopped' && run.stoppedReason === 'held') throw conflict('lifecycle.tenantHeld');
  }

  /** Предпросмотр каскада: шаги плана, ожидаемые строки, незарегистрированные хуки. */
  async preview(workspaceId: WorkspaceId): Promise<{ steps: LifecycleTenantPreviewStep[]; missing: string[] }> {
    const steps: LifecycleTenantPreviewStep[] = [];
    const missing: string[] = [];
    for (const step of lifecycleTenantPurgePlan()) {
      if (step.kind === 'hook') {
        const hook = this.hooks.get(step.key);
        if (!hook && !LIFECYCLE_PENDING_KEYS[step.key]) missing.push(step.key);
        steps.push({ key: step.key, kind: 'hook', policies: [...step.policies], registered: !!hook, rows: hook?.estimate ? await hook.estimate(workspaceId) : null });
      } else {
        const policy = lifecyclePolicy(step.policy)!;
        const t = lifecycleTableOf(policy);
        let rows: number | null = null;
        if (t) {
          const [r] = await this.db.$queryRaw<Array<{ n: bigint }>>(tenantEstimateSql(t, step.column, workspaceId));
          rows = Number(r?.n ?? 0);
        }
        steps.push({ key: step.key, kind: 'batched', policies: [step.policy], registered: !!t, rows });
      }
    }
    return { steps, missing };
  }

  // ---------------------------------------------------------------- джоб

  private async handle(payload: TenantPurgePayload): Promise<void> {
    if (!payload?.workspaceId || !payload?.runId) throw new JobDiscardError('lifecycle.tenant-purge: workspaceId and runId are required');
    const run = await this.runs.get(payload.runId);
    if (!run) throw new JobDiscardError(`lifecycle.tenant-purge: run ${payload.runId} is gone`);
    if (run.status !== 'running') return;
    const outcome = await this.execute(payload.runId, payload.workspaceId as WorkspaceId, Date.now() + LIFECYCLE_LIMITS.jobBudgetMs, run.report.orphan === true);
    if (outcome === 'continue') throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'budget spent, continuing');
  }

  // ---------------------------------------------------------------- исполнение

  private async execute(runId: string, workspaceId: WorkspaceId, deadline: number | null, orphan: boolean): Promise<'done' | 'continue'> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error(`tenant purge run ${runId} is gone`);
    if (run.status !== 'running') return 'done';
    // Вид сущности — на КАЖДОМ заходе: между заходами организацию могли восстановить из архива
    if (!orphan) {
      const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
      if (ws?.isActive) {
        await this.runs.finish(runId, 'stopped', { stoppedReason: 'cancelled', report: { restored: true } });
        return 'done';
      }
    }
    const done = new Set<string>(Array.isArray(run.report.done) ? (run.report.done as string[]) : []);
    const held = async () => {
      if (!(await this.isHeld(workspaceId))) return false;
      await this.runs.finish(runId, 'stopped', { stoppedReason: 'held', report: { done: [...done] } });
      this.logger.warn(`tenant purge of ${workspaceId} stopped: the organisation is under a legal hold`);
      return true;
    };
    const ctx: LifecycleTenantPurgeContext = {
      runId,
      dryRun: false,
      deadline,
      checkpoint: async () => {
        if (await this.isHeld(workspaceId)) throw new LifecycleTenantHeldError(workspaceId);
      },
      releasable: (tx, policyId, ids) => {
        const policy = lifecyclePolicy(policyId);
        if (!policy) throw new Error(`tenant purge: unknown policy ${policyId}`);
        return releasableIds(tx, policy, ids);
      },
    };
    for (const step of lifecycleTenantPurgePlan()) {
      if (done.has(step.key)) continue;
      if (orphan && step.key === 'workspaces.row') continue;
      if (deadline !== null && Date.now() > deadline) return 'continue';
      if (await held()) return 'done';
      const started = Date.now();
      let rows = 0;
      if (step.kind === 'hook') {
        const hook = this.hooks.get(step.key);
        if (!hook) {
          if (LIFECYCLE_PENDING_KEYS[step.key]) continue;
          throw new Error(`tenant purge hook "${step.key}" is not registered — the cascade stops here (its data would outlive the organisation)`);
        }
        let res: void | { rows?: number; done?: boolean };
        try {
          res = await hook.purge(workspaceId, ctx);
        } catch (err) {
          if (err instanceof LifecycleTenantHeldError) {
            await held();
            return 'done';
          }
          this.metrics.tenantStepFailed(step.key);
          throw new Error(`tenant purge hook "${step.key}" failed for ${workspaceId}: ${err instanceof Error ? err.message : err}`);
        }
        rows = res && typeof res.rows === 'number' ? res.rows : 0;
        if (res && res.done === false) {
          if (rows) await this.runs.progress(null, runId, rows, 1);
          return 'continue';
        }
      } else {
        const res = await this.batched(step, workspaceId, deadline);
        rows = res.rows;
        if (!res.done) {
          if (rows) await this.runs.progress(null, runId, rows, 1);
          return 'continue';
        }
      }
      done.add(step.key);
      await this.runs.progress(null, runId, rows, 1);
      await this.runs.saveState(runId, { done: [...done] });
      this.metrics.tenantStep(step.key, Date.now() - started);
    }
    await this.runs.finish(runId, 'done', { report: { done: [...done] } });
    this.logger.log(`tenant purge of ${workspaceId} finished (${done.size} steps)`);
    return 'done';
  }

  /** Строки политики организации пачками; удерживаемые заморозкой остаются. */
  private async batched(step: Extract<LifecycleTenantPurgeStep, { kind: 'batched' }>, workspaceId: string, deadline: number | null): Promise<{ rows: number; done: boolean }> {
    const policy = lifecyclePolicy(step.policy)!;
    const t = lifecycleTableOf(policy);
    if (!t) throw new Error(`tenant purge: ${step.policy} has no table`);
    let rows = 0;
    let limit: number = LIFECYCLE_LIMITS.batchStart;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows, done: false };
      const started = Date.now();
      const n = await this.db.$transaction(async (tx) => {
        await lockHoldsShared(tx);
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LIFECYCLE_LIMITS.batchLockTimeoutMs}ms`}, true)`;
        return tx.$executeRaw(tenantBatchSql(policy, t, step.column, workspaceId, limit));
      });
      rows += n;
      if (n < limit) return { rows, done: true };
      const elapsed = Date.now() - started;
      limit =
        elapsed <= LIFECYCLE_LIMITS.batchTargetMs
          ? Math.min(LIFECYCLE_LIMITS.batchMax, Math.ceil(limit * LIFECYCLE_LIMITS.batchGrow))
          : Math.max(LIFECYCLE_LIMITS.batchMin, Math.floor(limit * LIFECYCLE_LIMITS.batchShrink));
    }
  }
}
