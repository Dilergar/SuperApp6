import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LifecycleRunKind, LifecycleRunStatus, LifecycleStopReason } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AuditService } from '../audit/audit.service';

type Tx = Prisma.TransactionClient;

/** Прогон движка глазами кода (строка `lifecycle_runs`). */
export interface LifecycleRunRow {
  id: string;
  policyId: string | null;
  kind: LifecycleRunKind;
  status: LifecycleRunStatus;
  dryRun: boolean;
  subjectType: string | null;
  subjectId: string | null;
  rows: number;
  batches: number;
  expectedRows: number | null;
  stoppedReason: LifecycleStopReason | null;
  report: Record<string, unknown>;
  startedAt: Date;
  finishedAt: Date | null;
}

function toRow(r: {
  id: string;
  policyId: string | null;
  kind: string;
  status: string;
  dryRun: boolean;
  subjectType: string | null;
  subjectId: string | null;
  rows: bigint;
  batches: number;
  expectedRows: bigint | null;
  stoppedReason: string | null;
  report: Prisma.JsonValue;
  startedAt: Date;
  finishedAt: Date | null;
}): LifecycleRunRow {
  return {
    ...r,
    kind: r.kind as LifecycleRunKind,
    status: r.status as LifecycleRunStatus,
    rows: Number(r.rows),
    expectedRows: r.expectedRows === null ? null : Number(r.expectedRows),
    stoppedReason: r.stoppedReason as LifecycleStopReason | null,
    report: r.report && typeof r.report === 'object' && !Array.isArray(r.report) ? (r.report as Record<string, unknown>) : {},
  };
}

/**
 * Журнал прогонов движка (`lifecycle_runs`): прогресс пачек, ожидание, причина остановки,
 * отчёт dry-run. Строка прогона — ещё и состояние джоба: снуз и повтор продолжают её же
 * (правило, текущая пачка AIMD, пройденные шаги каскада — в `report`).
 *
 * Конец прогона purge доказывается событием журнала безопасности `lifecycle.purge.run`
 * (NIST 800-88: удаление, которое нельзя доказать, для регулятора не случилось).
 */
@Injectable()
export class LifecycleRuns {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async start(
    tx: Tx | null,
    input: {
      kind: LifecycleRunKind;
      policyId?: string | null;
      dryRun?: boolean;
      subjectType?: string | null;
      subjectId?: string | null;
      report?: Record<string, unknown>;
    },
  ): Promise<string> {
    const row = await (tx ?? this.db).lifecycleRun.create({
      data: {
        kind: input.kind,
        policyId: input.policyId ?? null,
        dryRun: input.dryRun ?? false,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        report: (input.report ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  async get(id: string): Promise<LifecycleRunRow | null> {
    const r = await this.db.lifecycleRun.findUnique({ where: { id } });
    return r ? toRow(r) : null;
  }

  /** Незаконченный прогон того же вида и субъекта (каскад организации не ставится дважды). */
  async findRunning(kind: LifecycleRunKind, where: { policyId?: string; subjectId?: string }, tx?: Tx): Promise<LifecycleRunRow | null> {
    const r = await (tx ?? this.db).lifecycleRun.findFirst({
      where: { kind, status: 'running', ...(where.policyId ? { policyId: where.policyId } : {}), ...(where.subjectId ? { subjectId: where.subjectId } : {}) },
      orderBy: { startedAt: 'desc' },
    });
    return r ? toRow(r) : null;
  }

  /** +строк и пачек (в транзакции пачки — прогресс не расходится с фактом). */
  async progress(tx: Tx | null, id: string, rows: number, batches = 1): Promise<void> {
    await (tx ?? this.db).$executeRaw`
      UPDATE "lifecycle_runs" SET rows = rows + ${rows}, batches = batches + ${batches} WHERE id = ${id}::uuid`;
  }

  /** Состояние продолжения (слияние в `report`). */
  async saveState(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "lifecycle_runs" SET report = COALESCE(report, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${id}::uuid`;
  }

  async setExpected(id: string, expected: number): Promise<void> {
    await this.db.lifecycleRun.update({ where: { id }, data: { expectedRows: BigInt(expected) } });
  }

  /**
   * Закрыть прогон (status-guarded: закрытый не переоткрывается и не закрывается дважды) и
   * доказать его журналом. Возвращает, закрыл ли именно этот вызов.
   */
  async finish(
    id: string,
    status: Exclude<LifecycleRunStatus, 'running'>,
    opts: { stoppedReason?: LifecycleStopReason | null; report?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const patch = JSON.stringify(opts.report ?? {});
      const closed = await tx.$queryRaw<Array<{ policy_id: string | null; kind: string; rows: bigint; batches: number; dry_run: boolean }>>`
        UPDATE "lifecycle_runs"
           SET status = ${status}, stopped_reason = ${opts.stoppedReason ?? null}, finished_at = clock_timestamp(),
               report = COALESCE(report, '{}'::jsonb) || ${patch}::jsonb
         WHERE id = ${id}::uuid AND status = 'running'
        RETURNING policy_id, kind, rows, batches, dry_run`;
      const run = closed[0];
      if (!run) return false;
      if (run.kind === 'purge' && run.policy_id) {
        await this.audit.record(tx, {
          key: 'lifecycle.purge.run',
          actor: { kind: 'system' },
          outcome: status === 'done' ? 'success' : 'failure',
          reasonCode: opts.stoppedReason ?? (status === 'failed' ? 'failed' : null),
          target: { type: 'lifecycle_policy', id: run.policy_id },
          details: {
            policy: run.policy_id,
            rows: Number(run.rows),
            batches: run.batches,
            dryRun: run.dry_run,
            ...(opts.stoppedReason ? { stopped: opts.stoppedReason } : status === 'failed' ? { stopped: 'failed' } : {}),
          },
        });
      }
      return true;
    });
  }
}
