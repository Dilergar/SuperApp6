import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  approvePairOf,
  redactForAudit,
  type PlatformCommandDto,
  type PlatformCommandPreviewDto,
  type PlatformCommandResultDto,
  type PlatformCommandRunInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { DryRun } from '../../shared/context/dry-run.context';
import { EventBusService } from '../../shared/events/event-bus.service';
import { ApiError, badRequest, conflict, forbidden, isApiError, notFound } from '../../shared/errors/api-error';
import type { PlatformActor } from '../../shared/decorators/platform.decorator';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import {
  PlatformCommandRegistry,
  commandNeedsReason,
  commandNeedsStepUp,
  type CommandContext,
  type CommandOutcome,
  type CommandTarget,
  type PlatformCommandDef,
} from './platform-commands.registry';
import { PlatformPolicyService } from './platform-policy.service';
import { PlatformRateService } from './platform-rate.service';
import { PlatformNotifier } from './platform.notifications';
import { PlatformRequestsService } from './platform-requests.service';
import { PLATFORM_BUS_EVENTS } from './platform.constants';

/** Сентинел отката предпросмотра: транзакция ВСЕГДА откатывается, эффектов нет (S6). */
class PreviewRollback extends Error {
  constructor(readonly outcome: CommandOutcome) {
    super('preview rollback');
  }
}

type RequestRow = Prisma.PlatformCommandRequestGetPayload<object>;

/**
 * Исполнитель команд — единственная дверь мутаций кабинета. Конвейер:
 * команда найдена → capability → step-up (risk ≥ high) → причина (risk ≥ high) →
 * списки ≤ 200 → dual control по политике → идемпотентность (повтор = прежний
 * результат, другой вход = 409) → маскирование входа → $transaction { execute;
 * audit } → после коммита шина `platform.command.executed`. Отказы — в журнал вне tx.
 */
@Injectable()
export class PlatformCommandsService {
  private readonly logger = new Logger(PlatformCommandsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: PlatformCommandRegistry,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
    private readonly policy: PlatformPolicyService,
    private readonly access: PlatformAccessService,
    private readonly rate: PlatformRateService,
    private readonly events: EventBusService,
    private readonly notifier: PlatformNotifier,
    @Inject(forwardRef(() => PlatformRequestsService)) private readonly requests: PlatformRequestsService,
  ) {}

  // ============================================================
  // Витрина реестра
  // ============================================================

  listFor(actor: PlatformActor): PlatformCommandDto[] {
    return this.registry
      .list()
      .filter((d) => actor.capabilities.includes(d.capability))
      .map((d) => this.toDto(d));
  }

  toDto(d: PlatformCommandDef): PlatformCommandDto {
    return {
      key: d.key,
      version: d.version,
      group: d.group,
      titleKey: d.titleKey,
      descriptionKey: d.descriptionKey ?? null,
      capability: d.capability,
      risk: d.risk,
      dualControl: !!d.dualControl,
      stepUp: commandNeedsStepUp(d),
      reasonRequired: commandNeedsReason(d),
      dryRun: !!d.dryRun || !!d.preview,
      entities: d.entities ?? [],
      inputSchema: zodToJsonSchema(d.input, { $refStrategy: 'none' }) as Record<string, unknown>,
    };
  }

  // ============================================================
  // Выполнение
  // ============================================================

  async run(actor: PlatformActor, key: string, body: PlatformCommandRunInput): Promise<PlatformCommandResultDto> {
    const started = Date.now();
    const def = this.registry.get(key);
    if (!def) throw notFound('platform.command_not_found', undefined, { code: PLATFORM_ERROR_CODES.commandNotFound });

    const denied = async (errorCode: string, extra?: Record<string, unknown>) => {
      await this.audit.writeDenied({
        actorId: actor.userId,
        actorRolesSnapshot: actor.roles,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: def.key,
        commandVersion: def.version,
        input: redactForAudit(body.input, def.redact ?? []),
        errorCode,
        risk: def.risk,
        reason: body.reason ?? null,
        ticketRef: body.ticketRef ?? null,
        idempotencyKey: null,
        ip: actor.ip,
        userAgent: actor.userAgent,
        durationMs: Date.now() - started,
        ...extra,
      });
    };

    // 1. capability
    if (!actor.capabilities.includes(def.capability)) {
      await denied(PLATFORM_ERROR_CODES.capabilityDenied);
      throw forbidden('platform.capability_denied', { capability: def.capability }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    // 2. вход по схеме команды (.strict в декларациях)
    const parsed = def.input.safeParse(body.input ?? {});
    if (!parsed.success) throw parsed.error;
    const input = parsed.data as unknown;
    this.assertListSizes(input);
    const target = def.target(input);

    // 3. цель — не сам актор (у команд, выдающих права)
    if (await this.isSelfTarget(def, actor.userId, target)) {
      await denied(PLATFORM_ERROR_CODES.selfTarget);
      throw forbidden('platform.self_target', undefined, { code: PLATFORM_ERROR_CODES.selfTarget });
    }

    // 4. step-up
    let stepUpAt: Date | null = null;
    if (commandNeedsStepUp(def)) {
      if (!actor.sudoUntil || actor.sudoUntil.getTime() <= Date.now()) {
        await denied(PLATFORM_ERROR_CODES.stepUpRequired);
        throw forbidden('platform.step_up_required', undefined, { code: PLATFORM_ERROR_CODES.stepUpRequired });
      }
      stepUpAt = new Date();
      await this.auth.refreshSudo(actor.sessionId);
    }
    // 5. причина
    const reason = body.reason?.trim() || null;
    if (commandNeedsReason(def) && (!reason || reason.length < PLATFORM_LIMITS.reasonMinLength)) {
      throw badRequest('platform.reason_required', { min: PLATFORM_LIMITS.reasonMinLength }, { code: PLATFORM_ERROR_CODES.reasonRequired });
    }

    // 6. идемпотентность (S5): тот же ключ → прежний результат; другой вход → 409
    const inputHash = this.hashInput(input);
    const prior = await this.audit.findByIdempotency(this.db, actor.userId, def.key, body.idempotencyKey);
    if (prior) {
      if (prior.inputHash !== inputHash) {
        throw conflict('platform.idempotency_mismatch', undefined, { code: PLATFORM_ERROR_CODES.idempotencyMismatch });
      }
      const priorResult = (prior.after as { __result?: unknown } | null) ?? null;
      return {
        status: (prior.after as { __pending?: boolean } | null)?.__pending ? 'pending' : 'ok',
        auditId: prior.id,
        requestId: (prior.after as { __requestId?: string } | null)?.__requestId ?? null,
        result: priorResult && '__result' in priorResult ? priorResult.__result : prior.after,
        before: prior.before,
        after: this.stripMeta(prior.after),
        replayed: true,
      };
    }

    // 7. dual control по политике. Мягкий режим: одобряющих нет вовсе (один владелец) →
    // исполняем напрямую, иначе кабинет запирается — добавить второго сотрудника и
    // выключить политику было бы нельзя одновременно. Строка журнала такой команды
    // отличима: `dualControl` есть, а `approvalId` пуст.
    const dualControlLive = !!def.dualControl && (await this.policy.dualControlEnabled());
    let soloDualControl = false;
    if (dualControlLive && def.dualControlSoft) {
      const approveCap = approvePairOf(def.capability);
      const approvers = approveCap ? await this.access.holdersOf(approveCap, { exclude: actor.userId }) : [];
      soloDualControl = approvers.length === 0;
    }
    if (dualControlLive && !soloDualControl) {
      const request = await this.requests.submit(actor, def, input, { reason, ticketRef: body.ticketRef ?? null, idempotencyKey: body.idempotencyKey, target });
      const entry = await this.audit.write(null, {
        actorId: actor.userId,
        actorRolesSnapshot: actor.roles,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: def.key,
        commandVersion: def.version,
        input: redactForAudit(input, def.redact ?? []),
        inputHash,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        targetWorkspaceId: target?.workspaceId ?? null,
        after: { __pending: true, __requestId: request.id },
        outcome: 'ok',
        readOnly: true,
        risk: def.risk,
        reason,
        ticketRef: body.ticketRef ?? null,
        stepUpAt,
        idempotencyKey: body.idempotencyKey,
        ip: actor.ip,
        userAgent: actor.userAgent,
        durationMs: Date.now() - started,
      });
      return { status: 'pending', auditId: entry.id, requestId: request.id, result: null, before: null, after: null, replayed: false };
    }

    // 8. исполнение + журнал в одной транзакции
    const ctx: CommandContext = { actor, reason, ticketRef: body.ticketRef ?? null, approvalId: null };
    let outcome: CommandOutcome;
    let auditId: string;
    try {
      const res = await this.db.$transaction(async (tx) => {
        const out = await def.execute(ctx, input, tx);
        const entry = await this.audit.write(tx, {
          actorId: actor.userId,
          actorRolesSnapshot: actor.roles,
          sessionId: actor.sessionId,
          requestId: actor.requestId,
          commandKey: def.key,
          commandVersion: def.version,
          input: redactForAudit(input, def.redact ?? []),
          inputHash,
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          targetWorkspaceId: target?.workspaceId ?? null,
          before: out.before ?? null,
          after: this.afterForAudit(def, out),
          outcome: 'ok',
          risk: def.risk,
          reason,
          ticketRef: body.ticketRef ?? null,
          stepUpAt,
          idempotencyKey: body.idempotencyKey,
          ip: actor.ip,
          userAgent: actor.userAgent,
          durationMs: Date.now() - started,
        });
        return { out, entryId: entry.id };
      });
      outcome = res.out;
      auditId = res.entryId;
    } catch (err) {
      // Гонка идемпотентности: параллельный повтор успел записать — отдаём его результат
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.audit.findByIdempotency(this.db, actor.userId, def.key, body.idempotencyKey);
        if (again) return { status: 'ok', auditId: again.id, requestId: null, result: this.stripMeta(again.after), before: again.before, after: this.stripMeta(again.after), replayed: true };
      }
      const code = isApiError(err) ? (err as ApiError).code : 'error';
      await this.audit.write(null, {
        actorId: actor.userId,
        actorRolesSnapshot: actor.roles,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        commandKey: def.key,
        commandVersion: def.version,
        input: redactForAudit(input, def.redact ?? []),
        inputHash,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        outcome: 'error',
        errorCode: code,
        risk: def.risk,
        reason,
        ticketRef: body.ticketRef ?? null,
        stepUpAt,
        ip: actor.ip,
        userAgent: actor.userAgent,
        durationMs: Date.now() - started,
      }).catch(() => undefined);
      throw err;
    }
    await this.invalidateStaff(outcome);
    if (soloDualControl) {
      // Владельцев станет двое — они увидят, что команда прошла в одиночку
      await this.notifier.securityAlert(null, actor.userId, 'soloDualControl', def.key).catch(() => undefined);
    }
    this.events.emit(PLATFORM_BUS_EVENTS.commandExecuted, { auditId, commandKey: def.key, actorId: actor.userId, targetType: target?.type ?? null, targetId: target?.id ?? null }, 'platform');
    return { status: 'ok', auditId, requestId: null, result: outcome.result ?? null, before: outcome.before ?? null, after: outcome.after ?? null, replayed: false };
  }

  /** Исполнение одобренной заявки от имени автора (актор — автор; `approvalId` в журнале). */
  async executeApproved(request: RequestRow): Promise<string> {
    const def = this.registry.get(request.commandKey);
    if (!def) throw notFound('platform.command_not_found', undefined, { code: PLATFORM_ERROR_CODES.commandNotFound });
    const access = await this.access.accessOf(request.actorId);
    // Права автора проверяются в момент ИСПОЛНЕНИЯ, а не подачи: между заявкой и
    // одобрением автора могли приостановить или лишить роли — одобрение чужой
    // подписи не должно возвращать ему утраченное право (S8).
    if (access.status !== 'active') {
      throw forbidden('platform.not_staff', undefined, { code: PLATFORM_ERROR_CODES.notStaff });
    }
    if (!access.capabilities.includes(def.capability)) {
      throw forbidden('platform.capability_denied', { capability: def.capability }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    // Паспорт команды мог смениться деплоем, пока заявка ждала решения: одобряли ОДНУ
    // семантику, исполнилась бы другая. Версия хранится в заявке — сверяем её.
    if (request.commandVersion !== def.version) {
      throw conflict('platform.command_version_changed', undefined, { code: PLATFORM_ERROR_CODES.commandVersionChanged });
    }
    const actor: PlatformActor = {
      userId: request.actorId,
      sessionId: '',
      roles: access.roles,
      capabilities: access.capabilities,
      sudoUntil: null,
      sessionExpiresAt: new Date(),
      ip: null,
      userAgent: null,
      requestId: `approval:${request.approvalId ?? request.id}`,
    };
    const input = def.input.parse(request.input);
    const target = def.target(input);
    // Запрет «на себя» действует и на одобренной заявке: одобрение второго сотрудника
    // не превращает выдачу привилегии себе в допустимую операцию.
    if (await this.isSelfTarget(def, request.actorId, target)) {
      throw forbidden('platform.self_target', undefined, { code: PLATFORM_ERROR_CODES.selfTarget });
    }
    const ctx: CommandContext = { actor, reason: request.reason, ticketRef: request.ticketRef, approvalId: request.approvalId };
    const started = Date.now();
    let outcome: CommandOutcome | null = null;
    const { entryId, targetType, targetId } = await this.db.$transaction(async (tx) => {
      const out = await def.execute(ctx, input, tx);
      outcome = out;
      const entry = await this.audit.write(tx, {
        actorId: request.actorId,
        actorRolesSnapshot: access.roles,
        onBehalfOfId: request.decidedBy,
        requestId: actor.requestId,
        commandKey: def.key,
        commandVersion: def.version,
        input: redactForAudit(input, def.redact ?? []),
        inputHash: this.hashInput(input),
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        targetWorkspaceId: target?.workspaceId ?? null,
        before: out.before ?? null,
        after: this.afterForAudit(def, out),
        outcome: 'ok',
        risk: def.risk,
        reason: request.reason,
        ticketRef: request.ticketRef,
        approvalId: request.approvalId,
        idempotencyKey: null,
        durationMs: Date.now() - started,
      });
      return { entryId: entry.id, targetType: target?.type ?? null, targetId: target?.id ?? null };
    });
    if (outcome) await this.invalidateStaff(outcome);
    this.events.emit(PLATFORM_BUS_EVENTS.commandExecuted, { auditId: entryId, commandKey: def.key, actorId: request.actorId, targetType, targetId }, 'platform');
    return entryId;
  }

  /** Предпросмотр = execute внутри транзакции, которая ВСЕГДА откатывается (S6). */
  async preview(actor: PlatformActor, key: string, rawInput: unknown): Promise<PlatformCommandPreviewDto> {
    const def = this.registry.get(key);
    if (!def) throw notFound('platform.command_not_found', undefined, { code: PLATFORM_ERROR_CODES.commandNotFound });
    if (!actor.capabilities.includes(def.capability)) {
      throw forbidden('platform.capability_denied', { capability: def.capability }, { code: PLATFORM_ERROR_CODES.capabilityDenied });
    }
    if (!def.dryRun && !def.preview) throw badRequest('platform.preview_unsupported', undefined, { code: PLATFORM_ERROR_CODES.previewUnsupported });
    // Предпросмотр высокорисковой команды показывает `before` чужого субъекта — это
    // такое же чтение, как панель: те же ворота sudo и тот же бюджет просмотров, иначе
    // выгрузка шла бы предпросмотром в обход обоих.
    if (commandNeedsStepUp(def) && (!actor.sudoUntil || actor.sudoUntil.getTime() <= Date.now())) {
      throw forbidden('platform.step_up_required', undefined, { code: PLATFORM_ERROR_CODES.stepUpRequired });
    }
    await this.rate.assertViewBudget(actor);
    const input = def.input.parse(rawInput ?? {});
    this.assertListSizes(input);
    const ctx: CommandContext = { actor, reason: null, ticketRef: null, approvalId: null };
    const target = def.target(input);
    if (await this.isSelfTarget(def, actor.userId, target)) {
      throw forbidden('platform.self_target', undefined, { code: PLATFORM_ERROR_CODES.selfTarget });
    }
    // Предпросмотр — тоже ЧТЕНИЕ чужих данных (before/after высокорисковой команды),
    // поэтому он оставляет строку журнала с `dryRun`: «смотрел, но не менял».
    const logDry = (outcome: 'ok' | 'error', errorCode?: string) =>
      this.audit
        .write(null, {
          actorId: actor.userId,
          actorRolesSnapshot: actor.roles,
          sessionId: actor.sessionId,
          requestId: actor.requestId,
          commandKey: def.key,
          commandVersion: def.version,
          input: redactForAudit(input, def.redact ?? []),
          inputHash: this.hashInput(input),
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          targetWorkspaceId: target?.workspaceId ?? null,
          outcome,
          errorCode: errorCode ?? null,
          readOnly: true,
          dryRun: true,
          risk: def.risk,
          ip: actor.ip,
          userAgent: actor.userAgent,
        })
        .catch(() => undefined);

    if (def.preview) {
      try {
        const own = def.preview.bind(def);
        const out = await DryRun.run(() => own(ctx, input));
        await logDry('ok');
        return { before: out.before ?? null, after: out.after ?? null, result: out.result ?? null };
      } catch (err) {
        await logDry('error', isApiError(err) ? (err as ApiError).code : 'error');
        throw err;
      }
    }
    try {
      // Транзакция откатит строки БД, а признак предпросмотра гасит эффекты ВНЕ базы
      // (эпохи кэша в Redis, события шины) — их не откатило бы ничто.
      await DryRun.run(() =>
        this.db.$transaction(async (tx) => {
          const out = await def.execute(ctx, input, tx);
          throw new PreviewRollback(out);
        }),
      );
    } catch (err) {
      if (err instanceof PreviewRollback) {
        await logDry('ok');
        return { before: err.outcome.before ?? null, after: err.outcome.after ?? null, result: err.outcome.result ?? null };
      }
      await logDry('error', isApiError(err) ? (err as ApiError).code : 'error');
      throw err;
    }
    throw new Error('preview: transaction did not roll back');
  }

  // ============================================================
  // Утилиты
  // ============================================================

  /**
   * Цель команды — сам сотрудник (или организация, которой он владеет)? Читается
   * ТОЛЬКО владение: членство админом кабинет не разбирает — это уже предмет журнала
   * и четырёх глаз.
   */
  private async isSelfTarget(def: PlatformCommandDef, actorId: string, target: CommandTarget | null): Promise<boolean> {
    if (!def.forbidSelfTarget || !target) return false;
    if (target.type === 'user') return target.id === actorId;
    if (target.type === 'workspace') {
      const ws = await this.db.workspace.findUnique({ where: { id: target.id }, select: { ownerId: true } });
      return ws?.ownerId === actorId;
    }
    return false;
  }

  /** Сброс кэша способностей ПОСЛЕ коммита: внутри транзакции он гонится с чтением. */
  private async invalidateStaff(out: CommandOutcome): Promise<void> {
    for (const userId of out.invalidateStaff ?? []) await this.access.invalidate(userId);
  }

  private hashInput(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(this.stableSort(input))).digest('hex');
  }

  private stableSort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.stableSort(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = this.stableSort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  }

  /** Входы-списки ≤ maxListInput (S17): массивы id на любой глубине. */
  private assertListSizes(input: unknown): void {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        if (v.length > PLATFORM_LIMITS.maxListInput) {
          throw badRequest('platform.list_too_long', { max: PLATFORM_LIMITS.maxListInput }, { code: PLATFORM_ERROR_CODES.listTooLong });
        }
        v.forEach(walk);
      } else if (v && typeof v === 'object') {
        Object.values(v as Record<string, unknown>).forEach(walk);
      }
    };
    walk(input);
  }

  /** `after` для журнала: результат кладётся под `__result`, если команда не запретила его хранить (PII). */
  private afterForAudit(def: PlatformCommandDef, out: CommandOutcome): unknown {
    if (out.result !== undefined && def.persistResult !== false) return { ...(this.asObject(out.after) ?? {}), __result: out.result };
    return out.after ?? null;
  }

  private asObject(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }

  private stripMeta(after: unknown): unknown {
    const obj = this.asObject(after);
    if (!obj) return after;
    const { __result, __pending, __requestId, ...rest } = obj;
    void __pending;
    void __requestId;
    if (__result !== undefined && Object.keys(rest).length === 0) return __result;
    return Object.keys(rest).length ? rest : after;
  }
}
