import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIENCE_LABEL_FORMS,
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  PLATFORM_RISK_RANK,
  PLATFORM_ROLES,
  approvePairOf,
  isPlatformCapability,
  redactForAudit,
  type PlatformCapability,
  type PlatformPersonDto,
  type PlatformRequestDto,
  type PlatformRequestStatus,
  type PlatformRequestsPageDto,
  type PlatformRequestsQuery,
  type PlatformRisk,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { conflict, forbidden, notFound } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { ApprovalsRegistry } from '../approvals/approvals.registry';
import { ApprovalsService } from '../approvals/approvals.service';
import { AudiencesRegistry } from '../audiences/audiences.registry';
import { PlatformAccessService } from './platform-access.service';
import { PlatformCommandRegistry, type CommandTarget, type PlatformCommandDef } from './platform-commands.registry';
import { PlatformCommandsService } from './platform-commands.service';
import { PlatformNotifier } from './platform.notifications';
import { PLATFORM_COMMAND_REF_TYPE } from './platform.constants';

type RequestRow = Prisma.PlatformCommandRequestGetPayload<object>;

/**
 * Four-eyes на core/approvals: заявка кабинета = `ApprovalRequest` с предметом
 * `platform_command` и одним шагом на адресата `platform_capability` (держатели
 * `<cap>.approve`, автор исключён резолвером). Очередь живёт в кабинете: витрина
 * продукта такие заявки не показывает (`consoleOnly`), уведомляет их сам кабинет.
 * Решение → `onResolved` → исполнение той же командой с `approvalId` в журнале.
 */
@Injectable()
export class PlatformRequestsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformRequestsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
    private readonly approvalsRegistry: ApprovalsRegistry,
    private readonly audiences: AudiencesRegistry,
    private readonly access: PlatformAccessService,
    private readonly commands: PlatformCommandRegistry,
    private readonly notifier: PlatformNotifier,
    @Inject(forwardRef(() => PlatformCommandsService)) private readonly executor: PlatformCommandsService,
  ) {}

  onModuleInit(): void {
    this.audiences.register('platform_capability', {
      resolve: async (id, ctx, limit) => {
        if (!isPlatformCapability(id)) return [];
        const holders = await this.access.holdersOf(id, { exclude: ctx.initiatorId ?? undefined });
        return holders.slice(0, limit);
      },
      label: async (id) => ({ key: AUDIENCE_LABEL_FORMS.platformCapability, name: id }),
    });
    this.approvalsRegistry.register(PLATFORM_COMMAND_REF_TYPE, {
      consoleOnly: true,
      describeForCreate: async (userId, refId) => {
        const req = await this.db.platformCommandRequest.findUnique({ where: { id: refId } });
        if (!req || req.actorId !== userId || req.status !== 'pending') return null;
        return { title: req.commandKey, workspaceId: null, contentSha256: null };
      },
      canView: async (userId) => this.access.can(userId, 'platform.audit.read'),
      describeRef: async (refId) => {
        const req = await this.db.platformCommandRequest.findUnique({ where: { id: refId }, select: { commandKey: true } });
        return req ? { title: req.commandKey, icon: 'shield', href: `/platform/requests?id=${refId}` } : null;
      },
    });
    this.approvalsRegistry.registerOrigin(PLATFORM_COMMAND_REF_TYPE, {
      onResolved: (originRef, outcome) => this.onResolved(originRef, outcome),
    });
  }

  // ============================================================
  // Подача заявки (из исполнителя)
  // ============================================================

  async submit(
    actor: PlatformActor,
    def: PlatformCommandDef,
    input: unknown,
    meta: { reason: string | null; ticketRef: string | null; idempotencyKey: string; target: CommandTarget | null },
  ): Promise<RequestRow> {
    const approveCap = approvePairOf(def.capability);
    if (!approveCap) throw conflict('platform.no_approver', undefined, { code: PLATFORM_ERROR_CODES.noApprover });
    const approvers = await this.access.holdersOf(approveCap, { exclude: actor.userId });
    if (!approvers.length) throw conflict('platform.no_approver', undefined, { code: PLATFORM_ERROR_CODES.noApprover });

    const existing = await this.db.platformCommandRequest.findUnique({
      where: { actorId_commandKey_idempotencyKey: { actorId: actor.userId, commandKey: def.key, idempotencyKey: meta.idempotencyKey } },
    });
    if (existing) {
      // Повтор того же ключа: живую заявку отдаём как есть, а по закрытой (отклонена,
      // исполнена, отменена) молчать нельзя — иначе ответ «ждёт решения» указывал бы на
      // мёртвую заявку, которую уже никто не решит. Новый запуск = новый ключ.
      if (existing.status !== 'pending') {
        throw conflict('platform.request_not_pending', undefined, { code: PLATFORM_ERROR_CODES.requestNotPending });
      }
      if (existing.approvalId) return existing;
      // Заявка без согласования (процесс упал между двумя вставками) — дособираем.
      return this.attachApproval(actor, def, existing, approvers, meta.reason);
    }

    const request = await this.db.platformCommandRequest.create({
      data: {
        commandKey: def.key,
        commandVersion: def.version,
        input: input as Prisma.InputJsonValue,
        inputRedacted: redactForAudit(input, def.redact ?? []) as Prisma.InputJsonValue,
        targetType: meta.target?.type ?? null,
        targetId: meta.target?.id ?? null,
        actorId: actor.userId,
        reason: meta.reason,
        ticketRef: meta.ticketRef,
        idempotencyKey: meta.idempotencyKey,
        status: 'pending',
      },
    });

    return this.attachApproval(actor, def, request, approvers, meta.reason);
  }

  /** Согласование + уведомление адресатам; провал — заявка закрывается, ключ не «залипает». */
  private async attachApproval(
    actor: PlatformActor,
    def: PlatformCommandDef,
    request: RequestRow,
    approvers: string[],
    reason: string | null,
  ): Promise<RequestRow> {
    const approveCap = approvePairOf(def.capability);
    if (!approveCap) throw conflict('platform.no_approver', undefined, { code: PLATFORM_ERROR_CODES.noApprover });
    try {
      const approval = await this.approvals.create(
        actor.userId,
        {
          refType: PLATFORM_COMMAND_REF_TYPE,
          refId: request.id,
          steps: [{ order: 0, kind: 'approval', assigneeType: 'platform_capability', assigneeId: approveCap, rule: 'any' }],
        },
        { type: PLATFORM_COMMAND_REF_TYPE, ref: request.id },
      );
      const updated = await this.db.platformCommandRequest.update({ where: { id: request.id }, data: { approvalId: approval.id } });
      await this.notifier.requestPending(null, request.id, approvers, def.titleKey, reason, actor.userId);
      return updated;
    } catch (err) {
      await this.db.platformCommandRequest.updateMany({ where: { id: request.id, status: 'pending' }, data: { status: 'cancelled', errorCode: 'approval_create_failed' } });
      throw err;
    }
  }

  // ============================================================
  // Решение (из кабинета)
  // ============================================================

  async decide(actor: PlatformActor, requestId: string, outcome: 'approved' | 'rejected', comment: string | undefined): Promise<PlatformRequestDto> {
    const req = await this.db.platformCommandRequest.findUnique({ where: { id: requestId } });
    if (!req) throw notFound('platform.entity_not_found');
    if (req.status !== 'pending' || !req.approvalId) throw conflict('platform.request_not_pending', undefined, { code: PLATFORM_ERROR_CODES.requestNotPending });
    if (req.actorId === actor.userId) throw forbidden('platform.author_cannot_approve', undefined, { code: PLATFORM_ERROR_CODES.authorCannotApprove });
    const def = this.commands.get(req.commandKey);
    if (!def) throw notFound('platform.command_not_found', undefined, { code: PLATFORM_ERROR_CODES.commandNotFound });
    const approveCap = approvePairOf(def.capability);
    if (!approveCap || !actor.capabilities.includes(approveCap)) {
      throw forbidden('platform.capability_denied', { capability: approveCap ?? '?' }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    // Решение по высокорисковой команде — под sudo, как и прямое исполнение
    if (PLATFORM_RISK_RANK[def.risk] >= PLATFORM_RISK_RANK.high && (!actor.sudoUntil || actor.sudoUntil.getTime() <= Date.now())) {
      throw forbidden('platform.step_up_required', undefined, { code: PLATFORM_ERROR_CODES.stepUpRequired });
    }
    // SoD в момент решения (S8): держатель write без владельческого исключения не одобряет
    const exempt = actor.roles.length > 0 && actor.roles.every((r) => !!PLATFORM_ROLES[r].sodExempt);
    if (!exempt && actor.capabilities.includes(def.capability)) {
      throw conflict('platform.sod_conflict', { object: def.capability.replace(/\.write$/, '') }, { code: PLATFORM_ERROR_CODES.sodConflict });
    }

    const approval = await this.approvals.get(actor.userId, req.approvalId);
    if (!approval.myStepId) throw conflict('platform.request_not_pending', undefined, { code: PLATFORM_ERROR_CODES.requestNotPending });
    await this.db.platformCommandRequest.updateMany({
      where: { id: req.id, status: 'pending' },
      data: { decidedBy: actor.userId, decidedAt: new Date(), decisionComment: comment ?? null },
    });
    // Отклонение требует причины в движке согласований — подставляем нейтральную, если нет
    await this.approvals.decide(
      actor.userId,
      approval.myStepId,
      { decision: outcome, comment: comment ?? (outcome === 'rejected' ? '—' : undefined) },
      actor.ip,
      { fromConsole: true },
    );
    return (await this.get(actor, req.id))!;
  }

  /**
   * Автор отзывает свою заявку. Раньше это делалось продуктовым `POST /approvals/:id/cancel`
   * — то есть в обход кабинета; теперь продуктовая ручка заявки контура не трогает, и отзыв
   * живёт здесь.
   */
  async withdraw(actor: PlatformActor, requestId: string): Promise<PlatformRequestDto> {
    const req = await this.db.platformCommandRequest.findUnique({ where: { id: requestId } });
    if (!req) throw notFound('platform.entity_not_found');
    if (req.actorId !== actor.userId) throw forbidden('platform.not_author');
    if (req.status !== 'pending') throw conflict('platform.request_not_pending', undefined, { code: PLATFORM_ERROR_CODES.requestNotPending });
    const claimed = await this.db.platformCommandRequest.updateMany({
      where: { id: req.id, status: 'pending' },
      data: { status: 'cancelled', decidedBy: actor.userId, decidedAt: new Date() },
    });
    if (claimed.count !== 1) throw conflict('platform.request_not_pending', undefined, { code: PLATFORM_ERROR_CODES.requestNotPending });
    // Согласование закрываем после клейма: хук возврата увидит статус уже не `pending`
    // и второй раз заявку не тронет.
    if (req.approvalId) await this.approvals.cancel(actor.userId, req.approvalId, { fromConsole: true });
    return (await this.get(actor, req.id))!;
  }

  /** Хук возврата из core/approvals: одобрено → исполнить; отклонено → закрыть. */
  private async onResolved(requestId: string, outcome: 'approved' | 'rejected' | 'returned'): Promise<void> {
    const req = await this.db.platformCommandRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status !== 'pending') return;
    const def = this.commands.get(req.commandKey);
    if (outcome !== 'approved') {
      await this.db.platformCommandRequest.updateMany({ where: { id: req.id, status: 'pending' }, data: { status: 'rejected' } });
      await this.notifier.requestResolved(null, req.id, req.actorId, def?.titleKey ?? req.commandKey, 'rejected', req.decisionComment, req.decidedBy).catch(() => undefined);
      return;
    }
    const claimed = await this.db.platformCommandRequest.updateMany({ where: { id: req.id, status: 'pending' }, data: { status: 'approved' } });
    if (claimed.count !== 1) return;
    try {
      const auditId = await this.executor.executeApproved(req);
      await this.db.platformCommandRequest.updateMany({ where: { id: req.id, status: 'approved' }, data: { status: 'executed', executedAuditId: auditId } });
      await this.notifier.requestResolved(null, req.id, req.actorId, def?.titleKey ?? req.commandKey, 'approved', req.decisionComment, req.decidedBy).catch(() => undefined);
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message.slice(0, 100);
      this.logger.error(`approved request ${req.id} failed to execute: ${(err as Error).message}`);
      await this.db.platformCommandRequest.updateMany({ where: { id: req.id, status: 'approved' }, data: { status: 'failed', errorCode: code } });
      await this.notifier.requestResolved(null, req.id, req.actorId, def?.titleKey ?? req.commandKey, 'failed', req.decisionComment, req.decidedBy).catch(() => undefined);
    }
  }

  // ============================================================
  // Чтение
  // ============================================================

  async list(actor: PlatformActor, q: PlatformRequestsQuery): Promise<PlatformRequestsPageDto> {
    const limit = Math.min(q.limit ?? 50, 100);
    const state = q.state ?? 'pending';
    const where: Prisma.PlatformCommandRequestWhereInput =
      state === 'mine' ? { actorId: actor.userId } : state === 'history' ? { status: { not: 'pending' } } : { status: 'pending' };
    const cursorId = q.cursor ?? null;
    const rows = await this.db.platformCommandRequest.findMany({
      where: cursorId ? { AND: [where, { createdAt: { lt: (await this.db.platformCommandRequest.findUnique({ where: { id: cursorId }, select: { createdAt: true } }))?.createdAt ?? new Date() } }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const people = await this.access.peopleOf(page.map((r) => r.actorId));
    const items = await Promise.all(page.map((r) => this.toDto(actor, r, people.get(r.actorId) ?? null)));
    return { items, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  }

  async get(actor: PlatformActor, id: string): Promise<PlatformRequestDto | null> {
    const row = await this.db.platformCommandRequest.findUnique({ where: { id } });
    if (!row) return null;
    const people = await this.access.peopleOf([row.actorId]);
    return this.toDto(actor, row, people.get(row.actorId) ?? null);
  }

  private async toDto(actor: PlatformActor, r: RequestRow, person: PlatformPersonDto | null): Promise<PlatformRequestDto> {
    const def = this.commands.get(r.commandKey);
    const approveCap = def ? approvePairOf(def.capability) : null;
    const canDecide = r.status === 'pending' && r.actorId !== actor.userId && !!approveCap && actor.capabilities.includes(approveCap);
    let stepId: string | null = null;
    if (canDecide && r.approvalId) {
      try {
        stepId = (await this.approvals.get(actor.userId, r.approvalId)).myStepId;
      } catch {
        stepId = null;
      }
    }
    return {
      id: r.id,
      commandKey: r.commandKey,
      commandVersion: r.commandVersion,
      titleKey: def?.titleKey ?? r.commandKey,
      risk: (def?.risk ?? 'high') as PlatformRisk,
      input: r.inputRedacted ?? null,
      targetType: r.targetType,
      targetId: r.targetId,
      actorId: r.actorId,
      actor: person,
      reason: r.reason,
      status: r.status as PlatformRequestStatus,
      approvalId: r.approvalId,
      stepId,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionComment: r.decisionComment,
      executedAuditId: r.executedAuditId,
      errorCode: r.errorCode,
      createdAt: r.createdAt.toISOString(),
      canDecide: canDecide && !!stepId,
    };
  }

  /** Потолок списка (S17) — общий с исполнителем. */
  static get maxListInput(): number {
    return PLATFORM_LIMITS.maxListInput;
  }
}
