import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type LifecycleErasureRequest } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  LIFECYCLE_ACCOUNT_GRACE_DAYS,
  LIFECYCLE_EXPORT_PREFIX,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_QUEUE,
  LIFECYCLE_SUBJECT_ROOT_HOOK,
  asWorkspaceId,
  lifecycleCertificatePayload,
  lifecyclePolicy,
  lifecycleSubjectErasurePlan,
  lifecycleTenantPurgePlan,
  lifecyclePoliciesOf,
  type LifecycleErasureCertificate,
  type LifecycleErasureReceiptDto,
  type LifecycleErasureVerificationDto,
  type LifecycleErasureStatus,
  type LifecycleExportPart,
  type LifecycleSubjectErasureStep,
} from '@superapp/shared';
import { DELETED_USER_MARKER } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { appTmpPath } from '../../shared/fs/temp-file.util';
import { RedisService } from '../../shared/redis/redis.service';
import { notFound } from '../../shared/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { STORAGE_DRIVER, type StorageDriver } from '../files/storage/storage-driver';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { userScope, workspaceScope } from '../keys/keys.constants';
import { KeysMacService } from '../keys/keys.mac.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { LifecycleHoldsService } from './lifecycle.holds.service';
import { LifecycleMetrics } from './lifecycle.metrics';
import { LifecyclePurgeHandlerRegistry, LifecycleSubjectHookRegistry, type LifecycleSubjectEraseContext } from './lifecycle.purge.registry';
import { LifecycleRuns } from './lifecycle.runs';
import { lifecycleTableOf, lockHoldsShared, releasableIds, subjectBatchSql, subjectHeldSql } from './lifecycle.sql';
import { LifecycleTenantPurgeService, type LifecycleTenantPurgedInfo } from './lifecycle.tenant-purge';

type Tx = Prisma.TransactionClient;
type SubjectType = 'user' | 'workspace';
export interface LifecycleErasureSubject {
  type: SubjectType;
  id: string;
}

const DAY = 86_400_000;
const RECEIPT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Заявка ещё не исполнена — её можно отменить восстановлением (после начала исполнения — нет). */
const CANCELLABLE: LifecycleErasureStatus[] = ['scheduled', 'held'];
const TERMINAL: LifecycleErasureStatus[] = ['completed', 'cancelled', 'failed'];

/** Код квитанции: 26 знаков base32 (130 бит случайности) — `LIFECYCLE_RECEIPT_RE`. */
function receiptCode(): string {
  const bytes = randomBytes(17);
  let value = 0;
  let bits = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += RECEIPT_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Объекты выгрузки: части из `parts` (только под её собственным префиксом — чужой ключ в JSON
 * строки не удаляется никогда) и манифест.
 */
export function exportObjectKeys(exportId: string, parts: unknown): string[] {
  const prefix = `${LIFECYCLE_EXPORT_PREFIX}${exportId}/`;
  const keys = new Set<string>([`${prefix}manifest.json`]);
  if (Array.isArray(parts)) {
    for (const p of parts as Array<Partial<LifecycleExportPart>>) {
      if (p && typeof p.key === 'string' && p.key.startsWith(prefix) && !p.key.includes('..')) keys.add(p.key);
    }
  }
  return [...keys];
}

/**
 * Оркестратор стирания субъекта (человек или организация) — DELF / GitLab ghost / NIST 800-88.
 *
 * Заявка создаётся В ТРАНЗАКЦИИ планирования (удаление аккаунта, архив организации): строка +
 * квитанция (код отдаётся человеку один раз, в базе — sha256) + журнал + событие + джоб с
 * `runAt` = срок. Восстановление в грейс отменяет заявку в своей транзакции.
 *
 * Исполнение (джоб `lifecycle.erasure`) — по плану реестра (`lifecycleSubjectErasurePlan`):
 * корневой шаг `users.account` скрывает аккаунт и стирает ПДн строки (этап hidden), дальше
 * шаги модулей и общие шаги по колонкам `by` — пачками, под заморозками (удерживаемое
 * остаётся, заявка ждёт снятия в статусе `held`). Пройдено всё → hot_purged: журнал по
 * политикам, вебхук `lifecycle.person.redact` организациям человека, окно бэкапов +35 дней.
 * Тик движка доводит: ключи скоупа уничтожены (keys_destroyed) → окно бэкапов прошло →
 * completed с сертификатом, подписанным Ed25519 (аудитория `lifecycle`).
 *
 * Организация исполняется каскадом Э3 (`LifecycleTenantPurgeService`): оркестратор ставит
 * его в срок, наблюдатель каскада отмечает hot_purged.
 */
@Injectable()
export class LifecycleErasureService implements OnModuleInit {
  private readonly logger = new Logger(LifecycleErasureService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly audit: AuditService,
    private readonly mac: KeysMacService,
    private readonly signing: KeysSigningService,
    private readonly subjectHooks: LifecycleSubjectHookRegistry,
    private readonly handlers: LifecyclePurgeHandlerRegistry,
    private readonly runs: LifecycleRuns,
    private readonly holds: LifecycleHoldsService,
    private readonly tenant: LifecycleTenantPurgeService,
    private readonly metrics: LifecycleMetrics,
    private readonly webhooks: WebhooksService,
    private readonly redis: RedisService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(LIFECYCLE_JOBS.erasure, (payload) => this.handle(payload as { requestId?: string }), {
      queue: LIFECYCLE_QUEUE,
      queueConcurrency: 2,
      leaseMs: LIFECYCLE_LIMITS.erasure.budgetMs + 120_000,
      maxAttempts: 25,
      onDiscard: async (payload, info) => {
        const id = String((payload as Record<string, unknown>).requestId ?? '');
        if (id) await this.fail(id, info.error);
      },
    });
    this.tenant.onPurged((workspaceId, info) => this.markWorkspacePurged(workspaceId, info));
    // Шаги движка в плане стирания человека: ключи Redis с id человека и его выгрузки
    this.subjectHooks.register('lifecycle.redis', { erase: (userId) => this.eraseRedis(userId) });
    this.subjectHooks.register('lifecycle.exports', { erase: (userId) => this.deleteExports({ subjectType: 'user', subjectId: userId }) });
    // Строки, извлечённые из партиции под заморозкой, живут сутки после её снятия
    this.handlers.register('lifecycle.hold-store', {
      purgeBatch: async (ctx) => {
        const n = await this.db.$executeRaw`
          DELETE FROM "lifecycle_hold_store" s
           WHERE s.id IN (
             SELECT s2.id FROM "lifecycle_hold_store" s2 JOIN "lifecycle_holds" h ON h.id = s2.hold_id
              WHERE h.released_at IS NOT NULL AND h.released_at < ${new Date(Date.now() - DAY)}::timestamptz
              LIMIT ${ctx.limit})`;
        return { rows: n, more: n === ctx.limit };
      },
      estimate: async () => {
        const [r] = await this.db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM "lifecycle_hold_store" s JOIN "lifecycle_holds" h ON h.id = s.hold_id
           WHERE h.released_at IS NOT NULL AND h.released_at < ${new Date(Date.now() - DAY)}::timestamptz`;
        return Number(r?.n ?? 0);
      },
    });
  }

  // ============================================================
  // Заявка
  // ============================================================

  /** Псевдоним субъекта: HMAC платформенного ключа `lifecycle` (журнал и сертификат — без id). */
  pseudonym(subject: LifecycleErasureSubject): Promise<string> {
    return this.mac.tagged('lifecycle', `${subject.type}:${subject.id}`);
  }

  /**
   * Заявка В ТРАНЗАКЦИИ планирования. Прежняя живая заявка того же субъекта отменяется —
   * у новой своя квитанция (код прежней в базе не восстановим: хранится только отпечаток).
   * Возвращает код квитанции — показать ОДИН раз. `inline` — исполняет сам вызывающий
   * (канарейка: `execute` без джоба); сорвался — тик движка поставит джоб через 5 минут.
   */
  async request(
    tx: Tx,
    input: { subject: LifecycleErasureSubject; effectiveAt: Date; options?: { eraseMessages?: boolean }; hiddenAt?: Date | null; inline?: boolean },
  ): Promise<{ requestId: string; receipt: string }> {
    await this.cancelWhere(tx, input.subject, 'superseded');
    const receipt = receiptCode();
    const row = await tx.lifecycleErasureRequest.create({
      data: {
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        pseudonym: await this.pseudonym(input.subject),
        effectiveAt: input.effectiveAt,
        hiddenAt: input.hiddenAt ?? null,
        options: { eraseMessages: !!input.options?.eraseMessages },
        receiptHash: sha256(receipt),
      },
    });
    await this.journal(tx, row, 'requested');
    await this.audit.record(tx, {
      key: 'lifecycle.erasure.requested',
      subjectUserId: input.subject.type === 'user' ? input.subject.id : null,
      workspaceId: input.subject.type === 'workspace' ? input.subject.id : null,
      target: { type: 'lifecycle_erasure', id: row.id },
      details: { subjectType: input.subject.type, effectiveAt: input.effectiveAt.toISOString() },
    });
    if (!input.inline) await this.jobs.enqueue(tx, { type: LIFECYCLE_JOBS.erasure, payload: { requestId: row.id }, uniqueKey: `erasure:${row.id}`, runAt: input.effectiveAt });
    this.metrics.erasureStage(input.subject.type, 'requested');
    return { requestId: row.id, receipt };
  }

  /** Восстановление в грейс (вход в аккаунт, возврат организации из архива): заявка отменяется в той же транзакции. */
  cancel(tx: Tx, subject: LifecycleErasureSubject): Promise<number> {
    return this.cancelWhere(tx, subject, 'restored');
  }

  private async cancelWhere(tx: Tx, subject: LifecycleErasureSubject, reason: 'restored' | 'superseded'): Promise<number> {
    const rows = await tx.lifecycleErasureRequest.findMany({ where: { subjectType: subject.type, subjectId: subject.id, status: { in: CANCELLABLE } } });
    let n = 0;
    for (const r of rows) {
      const { count } = await tx.lifecycleErasureRequest.updateMany({
        where: { id: r.id, status: { in: CANCELLABLE } },
        data: { status: 'cancelled', completedAt: new Date(), errorCode: reason, lastProgressAt: new Date() },
      });
      if (!count) continue;
      n++;
      await this.journal(tx, r, 'cancelled');
      await this.stageEvent(tx, r, 'cancelled', 0, 0);
    }
    return n;
  }

  /** Живая заявка субъекта (для мастеров и дашборда). */
  active(subject: LifecycleErasureSubject): Promise<LifecycleErasureRequest | null> {
    return this.db.lifecycleErasureRequest.findFirst({ where: { subjectType: subject.type, subjectId: subject.id, status: { notIn: TERMINAL } }, orderBy: { requestedAt: 'desc' } });
  }

  // ============================================================
  // Исполнение
  // ============================================================

  private async handle(payload: { requestId?: string }): Promise<void> {
    if (!payload?.requestId) throw new JobDiscardError('lifecycle.erasure: requestId is required');
    const out = await this.execute(payload.requestId, Date.now() + LIFECYCLE_LIMITS.erasure.budgetMs);
    if (out === 'continue') throw new JobSnoozeError(LIFECYCLE_LIMITS.continueDelayMs, 'budget spent, continuing');
    if (out === 'held') throw new JobSnoozeError(LIFECYCLE_LIMITS.erasure.heldRetryMs, 'under a legal hold');
    if (out === 'wait') throw new JobSnoozeError(LIFECYCLE_LIMITS.healthSnoozeMs, 'organisation purge in progress');
    if (typeof out === 'number') throw new JobSnoozeError(out, 'not due yet');
  }

  /**
   * Один заход исполнения (джоб, дев-полигон, канарейка). `deadline: null` — без бюджета.
   * Возвращает: done | continue (бюджет) | held (заморозка) | wait (каскад организации идёт) |
   * число мс до срока.
   */
  async execute(requestId: string, deadline: number | null): Promise<'done' | 'continue' | 'held' | 'wait' | number> {
    const r = await this.db.lifecycleErasureRequest.findUnique({ where: { id: requestId } });
    if (!r) throw new JobDiscardError(`erasure request ${requestId} is gone`);
    if (TERMINAL.includes(r.status as LifecycleErasureStatus) || r.status === 'hot_purged' || r.status === 'keys_destroyed') return 'done';
    const wait = r.effectiveAt.getTime() - Date.now();
    if (wait > 0) return wait;
    return r.subjectType === 'workspace' ? this.executeWorkspace(r) : this.executeUser(r, deadline);
  }

  private async executeUser(r: LifecycleErasureRequest, deadline: number | null): Promise<'done' | 'continue' | 'held'> {
    const userId = r.subjectId;
    // Вид субъекта и его состояние — по БД на каждом заходе: восстановленный аккаунт не стирается
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { deletionScheduledAt: true, deletedAt: true } });
    if (!user || (!user.deletionScheduledAt && !user.deletedAt)) {
      // Корень (скрыть) первым: пока deletedAt пуст, ни один шаг не прошёл — отмена честная
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.lifecycleErasureRequest.updateMany({
          where: { id: r.id, status: { in: ['scheduled', 'held', 'running'] } },
          data: { status: 'cancelled', completedAt: new Date(), errorCode: user ? 'restored' : 'subject_missing', lastProgressAt: new Date() },
        });
        if (!count) return;
        await this.journal(tx, r, 'cancelled');
        await this.stageEvent(tx, r, 'cancelled', 0, 0);
      });
      return 'done';
    }
    await this.db.lifecycleErasureRequest.updateMany({ where: { id: r.id, status: { in: ['scheduled', 'held'] } }, data: { status: 'running', attempts: { increment: 1 } } });

    const running = await this.runs.findRunning('erasure', { subjectId: userId });
    const runId = running?.id ?? (await this.runs.start(null, { kind: 'erasure', subjectType: 'user', subjectId: userId, report: { requestId: r.id, done: [], stepRows: {} } }));
    const run = running ?? (await this.runs.get(runId))!;
    const done = new Set<string>(Array.isArray(run.report.done) ? (run.report.done as string[]) : []);
    const stepRows: Record<string, number> = { ...((run.report.stepRows as Record<string, number> | undefined) ?? {}) };
    // Организации человека — ДО шага членств: им уйдёт вебхук lifecycle.person.redact
    let orgs = Array.isArray(run.report.orgs) ? (run.report.orgs as string[]) : null;
    if (!orgs) {
      const rows = await this.db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true }, distinct: ['workspaceId'] });
      orgs = rows.map((m) => m.workspaceId);
      await this.runs.saveState(runId, { orgs });
    }

    const subjectHeld = await this.holds.custodianHeld(userId);
    let heldRows = 0;
    const heldSteps = new Set<string>();
    const deletedLabel = DELETED_USER_MARKER;
    const ctx: LifecycleSubjectEraseContext = {
      requestId: r.id,
      runId,
      deadline,
      deletedLabel,
      options: { eraseMessages: (r.options as { eraseMessages?: boolean } | null)?.eraseMessages === true },
      subjectHeld,
      releasable: (tx, policyId, ids) => {
        const policy = lifecyclePolicy(policyId);
        if (!policy) throw new Error(`erasure: unknown policy ${policyId}`);
        return releasableIds(tx, policy, ids);
      },
      held: (n) => {
        heldRows += n;
      },
    };

    for (const step of lifecycleSubjectErasurePlan()) {
      if (done.has(step.key)) continue;
      if (deadline !== null && Date.now() > deadline) {
        await this.runs.saveState(runId, { stepRows });
        return 'continue';
      }
      const heldBefore = heldRows;
      let rows = 0;
      let finished = true;
      // Заморозка платформы на этих данных — шаг не запускается (корень сам скроет, но не сотрёт)
      if (step.key !== LIFECYCLE_SUBJECT_ROOT_HOOK && (await this.holds.platformHeld(userId, step.kind === 'hook' ? step.covers : [step.policy]))) {
        heldRows += 1;
        heldSteps.add(step.key);
        continue;
      }
      if (step.kind === 'hook') {
        const hook = this.subjectHooks.get(step.key);
        // Незарегистрированный шаг — стоп (fail-closed): данные модуля пережили бы человека
        if (!hook) throw new Error(`subject erasure hook "${step.key}" is not registered — erasure stops here`);
        const res = await hook.erase(userId, ctx);
        rows = res && typeof res.rows === 'number' ? res.rows : 0;
        finished = !(res && res.done === false);
      } else {
        const res = await this.generic(step, userId, deadline, deletedLabel, ctx);
        rows = res.rows;
        finished = res.done;
      }
      if (rows) {
        stepRows[step.key] = (stepRows[step.key] ?? 0) + rows;
        await this.runs.progress(null, runId, rows, 1);
        this.metrics.erasureStepRows(step.key, rows);
      }
      if (step.key === LIFECYCLE_SUBJECT_ROOT_HOOK && !r.hiddenAt) await this.markHidden(r);
      if (!finished) {
        await this.runs.saveState(runId, { stepRows });
        return 'continue';
      }
      if (heldRows > heldBefore) heldSteps.add(step.key);
      else done.add(step.key);
      await this.runs.saveState(runId, { done: [...done], stepRows });
    }

    if (heldSteps.size || subjectHeld) {
      await this.db.lifecycleErasureRequest.updateMany({ where: { id: r.id, status: 'running' }, data: { status: 'held', errorCode: 'held' } });
      this.logger.warn(`erasure ${r.id}: ${heldRows} row(s) are under a legal hold (${[...heldSteps].join(', ') || 'custodian'}) — waiting for release`);
      return 'held';
    }
    await this.runs.finish(runId, 'done', { report: { done: [...done], stepRows } });
    await this.markHotPurged(r, stepRows, orgs);
    return 'done';
  }

  /** Общий шаг: строки политики по колонкам `by` пачками под общим замком заморозок. */
  private async generic(
    step: Extract<LifecycleSubjectErasureStep, { kind: 'generic' }>,
    userId: string,
    deadline: number | null,
    label: string,
    ctx: LifecycleSubjectEraseContext,
  ): Promise<{ rows: number; done: boolean }> {
    const policy = lifecyclePolicy(step.policy)!;
    const t = lifecycleTableOf(policy);
    if (!t) throw new Error(`erasure: ${step.policy} has no table for the generic step`);
    const limit = LIFECYCLE_LIMITS.erasure.batch;
    let rows = 0;
    for (;;) {
      if (deadline !== null && Date.now() > deadline) return { rows, done: false };
      const n = await this.db.$transaction(async (tx) => {
        await lockHoldsShared(tx);
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LIFECYCLE_LIMITS.batchLockTimeoutMs}ms`}, true)`;
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${LIFECYCLE_LIMITS.batchStatementTimeoutMs}ms`}, true)`;
        return tx.$executeRaw(subjectBatchSql(policy, t, step, userId, label, limit));
      });
      rows += n;
      if (n < limit) break;
    }
    const [h] = await this.db.$queryRaw<Array<{ n: bigint }>>(subjectHeldSql(policy, t, step, userId));
    const held = Number(h?.n ?? 0);
    if (held) ctx.held(held);
    return { rows, done: true };
  }

  /** Организация: каскад Э3 в срок. Строки уже нет — отмечаем по факту; восстановлена — отмена. */
  private async executeWorkspace(r: LifecycleErasureRequest): Promise<'done' | 'held' | 'wait'> {
    const ws = await this.db.workspace.findUnique({ where: { id: r.subjectId }, select: { isActive: true } });
    if (!ws) {
      await this.markWorkspacePurged(r.subjectId, null);
      return 'done';
    }
    if (ws.isActive) {
      await this.db.$transaction((tx) => this.cancelWhere(tx, { type: 'workspace', id: r.subjectId }, 'restored'));
      return 'done';
    }
    const wsId = asWorkspaceId(r.subjectId);
    if (await this.tenant.isHeld(wsId, { deep: true })) {
      await this.db.lifecycleErasureRequest.updateMany({ where: { id: r.id, status: { in: ['scheduled', 'running'] } }, data: { status: 'held', errorCode: 'held' } });
      return 'held';
    }
    await this.db.lifecycleErasureRequest.updateMany({ where: { id: r.id, status: { in: ['scheduled', 'held'] } }, data: { status: 'running', attempts: { increment: 1 } } });
    await this.tenant.schedule(wsId);
    return 'wait';
  }

  // ============================================================
  // Этапы
  // ============================================================

  private async markHidden(r: LifecycleErasureRequest): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.lifecycleErasureRequest.updateMany({ where: { id: r.id, hiddenAt: null }, data: { hiddenAt: new Date(), lastProgressAt: new Date() } });
      if (!count) return;
      await this.journal(tx, r, 'hidden');
      await this.stageEvent(tx, r, 'hidden', 0, 0);
    });
    r.hiddenAt = new Date();
    this.metrics.erasureStage(r.subjectType, 'hidden');
  }

  /**
   * Горячее стёрто: журнал по политикам (строки и версии — счётчики сертификата), вебхук
   * `lifecycle.person.redact` организациям человека, окно бэкапов +35 дней.
   */
  private async markHotPurged(r: LifecycleErasureRequest, stepRows: Record<string, number>, orgs: readonly string[] | null): Promise<void> {
    const plan = r.subjectType === 'user' ? lifecycleSubjectErasurePlan().map((s) => ({ key: s.key, policies: s.kind === 'hook' ? [...s.policies] : [s.policy] })) : lifecycleTenantPurgePlan().map((s) => ({ key: s.key, policies: s.kind === 'hook' ? [...s.policies] : [s.policy] }));
    const now = new Date();
    const total = Object.values(stepRows).reduce((a, b) => a + b, 0);
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.lifecycleErasureRequest.updateMany({
        where: { id: r.id, status: { in: ['scheduled', 'held', 'running'] } },
        data: { status: 'hot_purged', hotPurgedAt: now, backupsClearAt: new Date(now.getTime() + LIFECYCLE_LIMITS.erasure.backupsDays * DAY), lastProgressAt: now, errorCode: null },
      });
      if (!count) return;
      // Строка журнала на каждую политику шага: строки шага — на его первую политику
      const rowsOut: Prisma.LifecycleErasureJournalCreateManyInput[] = [];
      for (const step of plan) {
        step.policies.forEach((policyId, i) =>
          rowsOut.push({ requestId: r.id, pseudonym: r.pseudonym, stage: 'hot_purged', policyId, policyVersion: lifecyclePolicy(policyId)?.version ?? null, rows: i === 0 ? (stepRows[step.key] ?? 0) : 0 }),
        );
      }
      await tx.lifecycleErasureJournal.createMany({ data: rowsOut });
      await this.stageEvent(tx, r, 'hot_purged', total, plan.reduce((a, s) => a + s.policies.length, 0));
      // Интеграциям организаций человека: удалить его данные у себя (модель Shopify customers/redact)
      if (r.subjectType === 'user') {
        const dueBy = new Date(now.getTime() + 30 * DAY).toISOString();
        for (const ws of orgs ?? []) {
          await this.webhooks.emitMandatory(tx, { workspaceId: ws, eventKey: 'lifecycle.person.redact', payload: { userId: r.subjectId, erasedAt: now.toISOString(), dueBy } });
        }
      }
    });
    this.metrics.erasureStage(r.subjectType, 'hot_purged');
  }

  /** Наблюдатель каскада организации (Э3): горячее стёрто. Заявки нет (архив до Э4) — заводится. */
  private async markWorkspacePurged(workspaceId: string, info: LifecycleTenantPurgedInfo | null): Promise<void> {
    let r = await this.db.lifecycleErasureRequest.findFirst({ where: { subjectType: 'workspace', subjectId: workspaceId, status: { notIn: TERMINAL } }, orderBy: { requestedAt: 'desc' } });
    if (!r) {
      const created = await this.db.$transaction((tx) => this.request(tx, { subject: { type: 'workspace', id: workspaceId }, effectiveAt: new Date(), hiddenAt: new Date() }));
      r = await this.db.lifecycleErasureRequest.findUnique({ where: { id: created.requestId } });
      if (!r) return;
    }
    if (r.status === 'hot_purged' || r.status === 'keys_destroyed') return;
    if (!r.hiddenAt) await this.markHidden(r);
    await this.markHotPurged(r, info?.stepRows ?? {}, null);
  }

  /** Строка журнала стираний: псевдоним, этап, политика/версия, строки, ключи — без ПДн. */
  private async journal(tx: Tx, r: Pick<LifecycleErasureRequest, 'id' | 'pseudonym'>, stage: string, extra: { rows?: number; keyIds?: string[] } = {}): Promise<void> {
    await tx.lifecycleErasureJournal.create({ data: { requestId: r.id, pseudonym: r.pseudonym, stage, rows: extra.rows ?? 0, keyIds: extra.keyIds ?? [] } });
  }

  private async stageEvent(tx: Tx, r: LifecycleErasureRequest, stage: 'hidden' | 'hot_purged' | 'keys_destroyed' | 'backups_clear' | 'cancelled', rows: number, policies: number): Promise<void> {
    await this.audit.record(tx, {
      key: 'lifecycle.erasure.stage',
      actor: { kind: 'system' },
      subjectUserId: null,
      workspaceId: null,
      target: { type: 'lifecycle_erasure', id: r.id },
      details: { stage, rows, policies },
    });
  }

  private async fail(requestId: string, error: string): Promise<void> {
    await this.db.lifecycleErasureRequest.updateMany({
      where: { id: requestId, status: { in: ['scheduled', 'held', 'running'] } },
      data: { status: 'failed', errorCode: error.slice(0, 120), completedAt: new Date() },
    });
  }

  // ============================================================
  // Тик: ключи → окно бэкапов → сертификат; страховка потерянных джобов; SLO
  // ============================================================

  async tick(): Promise<{ keys: number; completed: number; requeued: number; redacted: number; legacy: number }> {
    const now = new Date();
    let keys = 0;
    let completed = 0;
    let requeued = 0;
    // Удаления аккаунтов, назначенные без заявки (до оркестратора, сбой постановки), — заявка
    // задним числом со сроком «назначено + грейс»: иначе такой аккаунт не стёрся бы никогда
    const legacyRows = await this.db.$queryRaw<Array<{ id: string; at: Date }>>`
      SELECT u.id::text AS id, u.deletion_scheduled_at AS at FROM "users" u
       WHERE u.deletion_scheduled_at IS NOT NULL AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "lifecycle_erasure_requests" r
            WHERE r.subject_type = 'user' AND r.subject_id = u.id AND r.status NOT IN ('completed', 'cancelled', 'failed'))
       LIMIT 200`;
    for (const u of legacyRows) {
      await this.db.$transaction((tx) => this.request(tx, { subject: { type: 'user', id: u.id }, effectiveAt: new Date(u.at.getTime() + LIFECYCLE_ACCOUNT_GRACE_DAYS * DAY) }));
    }
    const legacy = legacyRows.length;
    // Просроченные заявки без живого джоба (потерянная постановка) — снова в очередь (uniqueKey гасит дубль)
    for (const r of await this.db.lifecycleErasureRequest.findMany({ where: { status: { in: ['scheduled', 'running', 'held'] }, effectiveAt: { lt: new Date(now.getTime() - 5 * 60_000) } }, select: { id: true }, take: 200 })) {
      const res = await this.jobs.enqueue(null, { type: LIFECYCLE_JOBS.erasure, payload: { requestId: r.id }, uniqueKey: `erasure:${r.id}` });
      if (res.inserted) requeued++;
    }
    // Ключи скоупа уничтожены (все версии destroyed) → keys_destroyed
    for (const r of await this.db.lifecycleErasureRequest.findMany({ where: { status: 'hot_purged' }, take: 200 })) {
      const scope = r.subjectType === 'user' ? userScope(r.subjectId) : workspaceScope(r.subjectId);
      const live = await this.db.cryptoKeyVersion.count({ where: { key: { scope }, state: { not: 'destroyed' } } });
      if (live > 0) continue;
      const keyIds = (await this.db.cryptoKey.findMany({ where: { scope }, select: { id: true } })).map((k) => k.id);
      await this.db.$transaction(async (tx) => {
        const { count } = await tx.lifecycleErasureRequest.updateMany({ where: { id: r.id, status: 'hot_purged' }, data: { status: 'keys_destroyed', keysDestroyedAt: new Date(), lastProgressAt: new Date() } });
        if (!count) return;
        await this.journal(tx, r, 'keys_destroyed', { keyIds });
        await this.stageEvent(tx, r, 'keys_destroyed', 0, 0);
      });
      this.metrics.erasureStage(r.subjectType, 'keys_destroyed');
      keys++;
    }
    // Окно бэкапов прошло → сертификат
    for (const r of await this.db.lifecycleErasureRequest.findMany({ where: { status: 'keys_destroyed', backupsClearAt: { lte: now } }, take: 200 })) {
      if (await this.complete(r)) completed++;
    }
    const redacted = await this.workspaceRedactDue(now);
    // SLO: без прогресса дольше N дней — кроме ожидания ключей и бэкапов (это срок, а не застревание)
    const stuckBefore = new Date(now.getTime() - LIFECYCLE_LIMITS.erasure.stuckDays * DAY);
    const [stuck, held] = await Promise.all([
      this.db.lifecycleErasureRequest.count({ where: { status: { in: ['scheduled', 'running'] }, effectiveAt: { lt: stuckBefore }, lastProgressAt: { lt: stuckBefore } } }),
      this.db.lifecycleErasureRequest.count({ where: { status: 'held' } }),
    ]);
    this.metrics.erasureBacklog(stuck, held);
    if (stuck) this.logger.error(`${stuck} erasure request(s) made no progress for ${LIFECYCLE_LIMITS.erasure.stuckDays}+ days`);
    return { keys, completed, requeued, redacted, legacy };
  }

  /**
   * `lifecycle.workspace.redact`: через 48 часов после архивации — всем активным адресам
   * организации (интеграции отключены — пусть удалят её данные у себя). Отметка — в `options`
   * заявки организации (одна отправка на заявку).
   */
  private async workspaceRedactDue(now: Date): Promise<number> {
    const due = await this.db.lifecycleErasureRequest.findMany({
      where: { subjectType: 'workspace', status: { in: ['scheduled', 'held', 'running'] }, hiddenAt: { lt: new Date(now.getTime() - 48 * 3_600_000) } },
      take: 100,
    });
    let n = 0;
    for (const r of due) {
      const opts = (r.options ?? {}) as Record<string, unknown>;
      if (opts.redactSentAt) continue;
      await this.db.$transaction(async (tx) => {
        const count = await tx.$executeRaw`
          UPDATE "lifecycle_erasure_requests" SET options = COALESCE(options, '{}'::jsonb) || jsonb_build_object('redactSentAt', ${now.toISOString()}::text)
           WHERE id = ${r.id}::uuid AND NOT (COALESCE(options, '{}'::jsonb) ? 'redactSentAt')`;
        if (!count) return;
        await this.webhooks.emitMandatory(tx, {
          workspaceId: r.subjectId,
          eventKey: 'lifecycle.workspace.redact',
          payload: { workspaceId: r.subjectId, archivedAt: r.hiddenAt?.toISOString() ?? null, purgeAt: r.effectiveAt.toISOString() },
          includeArchived: true,
        });
        n++;
      });
    }
    return n;
  }

  /** Сертификат (NIST 800-88): журнал → счётчики по классам, версии политик, ключи; подпись Ed25519. */
  private async complete(r: LifecycleErasureRequest): Promise<boolean> {
    const journal = await this.db.lifecycleErasureJournal.findMany({ where: { requestId: r.id } });
    const counts: Record<string, number> = {};
    const policies: Record<string, number> = {};
    const keyIds = new Set<string>();
    for (const j of journal) {
      if (j.policyId) {
        policies[j.policyId] = j.policyVersion ?? 1;
        const cls = lifecyclePolicy(j.policyId)?.dataClass ?? 'other';
        counts[cls] = (counts[cls] ?? 0) + j.rows;
      }
      for (const k of j.keyIds) keyIds.add(k);
    }
    const completedAt = new Date();
    const cert: LifecycleErasureCertificate = {
      v: 1,
      subjectType: r.subjectType as 'user' | 'workspace',
      pseudonym: r.pseudonym,
      requestedAt: r.requestedAt.toISOString(),
      effectiveAt: r.effectiveAt.toISOString(),
      hiddenAt: r.hiddenAt?.toISOString() ?? null,
      hotPurgedAt: r.hotPurgedAt?.toISOString() ?? null,
      keysDestroyedAt: r.keysDestroyedAt?.toISOString() ?? null,
      backupsClearAt: r.backupsClearAt?.toISOString() ?? null,
      completedAt: completedAt.toISOString(),
      counts,
      policies,
      keyIds: [...keyIds].sort(),
    };
    const { kid, sig } = await this.signing.signRaw('lifecycle', lifecycleCertificatePayload(cert));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const done = await this.db.$transaction(async (tx) => {
      const { count } = await tx.lifecycleErasureRequest.updateMany({
        where: { id: r.id, status: 'keys_destroyed' },
        data: { status: 'completed', completedAt, lastProgressAt: completedAt, certificate: cert as unknown as Prisma.InputJsonObject, signature: Uint8Array.from(Buffer.from(sig, 'base64url')), kid },
      });
      if (!count) return false;
      await this.journal(tx, r, 'completed', { rows: total, keyIds: cert.keyIds });
      await this.stageEvent(tx, r, 'backups_clear', 0, 0);
      await this.audit.record(tx, {
        key: 'lifecycle.erasure.completed',
        actor: { kind: 'system' },
        subjectUserId: null,
        workspaceId: null,
        target: { type: 'lifecycle_erasure', id: r.id },
        details: { subjectType: r.subjectType as 'user' | 'workspace', rows: total, policies: Object.keys(policies).length, keys: cert.keyIds.length },
      });
      return true;
    });
    if (done) this.metrics.erasureStage(r.subjectType, 'completed');
    return done;
  }

  // ============================================================
  // Квитанция и проверка подписи
  // ============================================================

  async receipt(code: string): Promise<LifecycleErasureReceiptDto> {
    const r = await this.db.lifecycleErasureRequest.findUnique({ where: { receiptHash: sha256(code) } });
    if (!r) throw notFound('lifecycle.receiptNotFound');
    // Квитанция публична и в руках самого человека: заморозку она не выдаёт (хранитель о ней не
    // узнаёт), внутренний сбой — тоже; оба — «идёт» (сроки и тревоги видит платформа)
    const status = r.status === 'held' || r.status === 'failed' ? 'running' : (r.status as LifecycleErasureStatus);
    return {
      subjectType: r.subjectType as 'user' | 'workspace',
      status,
      requestedAt: r.requestedAt.toISOString(),
      effectiveAt: r.effectiveAt.toISOString(),
      hiddenAt: r.hiddenAt?.toISOString() ?? null,
      hotPurgedAt: r.hotPurgedAt?.toISOString() ?? null,
      keysDestroyedAt: r.keysDestroyedAt?.toISOString() ?? null,
      backupsClearAt: r.backupsClearAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      certificate: (r.certificate as unknown as LifecycleErasureCertificate | null) ?? null,
      signature: r.signature ? Buffer.from(r.signature).toString('base64url') : null,
      kid: r.kid,
    };
  }

  /** Проверка подписи сертификата квитанции сервером — архивно (ключ, выведенный ротацией, тоже). */
  async verifyReceipt(code: string): Promise<LifecycleErasureVerificationDto> {
    const r = await this.receipt(code);
    const checkedAt = new Date().toISOString();
    if (!r.certificate || !r.signature || !r.kid) return { state: 'pending', kid: null, checkedAt };
    return { state: (await this.verifyCertificate(r.certificate, r.kid, r.signature)) ? 'valid' : 'invalid', kid: r.kid, checkedAt };
  }

  /** Архивная проверка подписи сертификата (версия ключа могла уйти ротацией; компрометация — отказ). */
  async verifyCertificate(cert: LifecycleErasureCertificate, kid: string, signature: string): Promise<boolean> {
    const res = await this.signing.verifyArchival('lifecycle', { kid, data: lifecycleCertificatePayload(cert), sig: signature, signedAt: new Date(cert.completedAt) });
    return res.ok;
  }

  // ============================================================
  // Журнал стираний вне базы: NDJSON в объектном хранилище (реплей после восстановления)
  // ============================================================

  async exportJournal(limit = 5000): Promise<number> {
    const rows = await this.db.lifecycleErasureJournal.findMany({ where: { exportedAt: null }, orderBy: { id: 'asc' }, take: limit });
    if (!rows.length) return 0;
    const at = new Date();
    const first = rows[0]!.id.toString();
    const last = rows[rows.length - 1]!.id.toString();
    const key = `lifecycle/erasure-journal/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${String(at.getUTCDate()).padStart(2, '0')}/${first}-${last}.ndjson`;
    const body = rows
      .map((j) => JSON.stringify({ id: j.id.toString(), requestId: j.requestId, pseudonym: j.pseudonym, stage: j.stage, policyId: j.policyId, policyVersion: j.policyVersion, rows: j.rows, keyIds: j.keyIds, at: j.at.toISOString() }))
      .join('\n');
    const tmp = appTmpPath(`erasure-journal-${first}-${last}.ndjson`);
    await fs.writeFile(tmp, body + '\n');
    try {
      await this.storage.putFromFile(key, tmp, 'application/x-ndjson');
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    await this.db.lifecycleErasureJournal.updateMany({ where: { id: { gte: rows[0]!.id, lte: rows[rows.length - 1]!.id }, exportedAt: null }, data: { exportedAt: at } });
    return rows.length;
  }

  /**
   * Реплей журнала после восстановления бэкапа (рунбук, ДО открытия трафика): псевдонимы
   * стёртых людей сверяются с восстановленными аккаунтами всеми живыми версиями ключа
   * `lifecycle`; найденный живым — стирается заново без грейса. Возвращает число повторов.
   */
  async replayJournal(pseudonyms: ReadonlySet<string>): Promise<number> {
    if (!pseudonyms.size) return 0;
    let replays = 0;
    let after: string | undefined;
    for (;;) {
      const users = await this.db.user.findMany({ where: { phone: { not: { startsWith: 'deleted:' } }, ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: 1000 });
      if (!users.length) break;
      for (const u of users) {
        const tags = await this.mac.taggedAll('lifecycle', `user:${u.id}`);
        if (!tags.some((tag) => pseudonyms.has(tag))) continue;
        await this.db.$transaction(async (tx) => {
          await tx.user.updateMany({ where: { id: u.id, deletionScheduledAt: null }, data: { deletionScheduledAt: new Date() } });
          await this.request(tx, { subject: { type: 'user', id: u.id }, effectiveAt: new Date() });
        });
        replays++;
      }
      after = users[users.length - 1]!.id;
    }
    return replays;
  }

  // ============================================================
  // Шаги движка в плане стирания человека
  // ============================================================

  /**
   * Выгрузки субъекта целиком: сначала байты (части и манифест под префиксом выгрузки), потом
   * строки — обрыв посередине оставит строку, и следующий заход удалит байты снова (удаление
   * отсутствующего — не ошибка). Шаг стирания человека, каскад организации, срок.
   */
  async deleteExports(where: Prisma.LifecycleExportWhereInput): Promise<{ rows: number }> {
    let rows = 0;
    for (;;) {
      const batch = await this.db.lifecycleExport.findMany({ where, select: { id: true, parts: true }, orderBy: { id: 'asc' }, take: 100 });
      if (!batch.length) return { rows };
      for (const e of batch) {
        for (const key of exportObjectKeys(e.id, e.parts)) await this.storage.delete(key);
      }
      const { count } = await this.db.lifecycleExport.deleteMany({ where: { id: { in: batch.map((e) => e.id) } } });
      rows += count;
      if (batch.length < 100) return { rows };
    }
  }

  /** Ключи Redis человека: шаблоны семейств реестра (`subjectPattern` с `{user}`) → SCAN → DEL. */
  private async eraseRedis(userId: string): Promise<{ rows: number }> {
    const client = this.redis.getClient();
    let rows = 0;
    for (const p of lifecyclePoliciesOf('redis')) {
      if (p.store.kind !== 'redis' || !p.store.subjectPattern || p.onSubjectErasure.kind !== 'hard_delete') continue;
      const match = p.store.subjectPattern.replace('{user}', userId);
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 1000);
        cursor = next;
        if (keys.length) rows += await client.del(...keys);
      } while (cursor !== '0');
    }
    return { rows };
  }
}
