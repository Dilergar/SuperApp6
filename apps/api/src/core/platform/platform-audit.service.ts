import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  PLATFORM_LIMITS,
  type AuditEventKey,
  type AuditOutcome,
  type PlatformAccessKind,
  type PlatformAuditEntryDto,
  type PlatformAuditOutcome,
  type PlatformAuditPageDto,
  type PlatformAuditQuery,
  type PlatformRisk,
  type PlatformRoleKey,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { AuditActorInput, AuditService } from '../audit/audit.service';
import type { AuditQueryService, AuditRow } from '../audit/audit.query.service';
import { auditOutcomeOf } from '../audit/audit.codes';
import { PlatformAccessService } from './platform-access.service';
import { PLATFORM_AUDIT_KEYS } from './platform.constants';

type Tx = Prisma.TransactionClient;

export interface AuditWrite {
  actorId: string | null;
  actorRolesSnapshot?: PlatformRoleKey[];
  onBehalfOfId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  commandKey: string;
  commandVersion?: number;
  /** УЖЕ замаскированный вход */
  input?: unknown;
  inputHash?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetWorkspaceId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome: PlatformAuditOutcome;
  errorCode?: string | null;
  readOnly?: boolean;
  risk?: PlatformRisk;
  reason?: string | null;
  ticketRef?: string | null;
  approvalId?: string | null;
  stepUpAt?: Date | null;
  idempotencyKey?: string | null;
  dryRun?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  durationMs?: number;
}

/** Вид чтения → ключ события (явная таблица: ключ виден стражу `check:audit` литералом). */
const ACCESS_KEY_OF: Record<PlatformAccessKind, AuditEventKey> = {
  search: 'platform.access.search',
  view: 'platform.access.view',
  reveal: 'platform.access.reveal',
};

const OUTCOME_OF: Record<PlatformAuditOutcome, AuditOutcome> = { ok: 'success', denied: 'denied', error: 'failure' };
const PLATFORM_OUTCOME_OF: Record<AuditOutcome, PlatformAuditOutcome> = { success: 'ok', denied: 'denied', failure: 'error', unknown: 'error' };

/** События вкладки «Команды» Кабинета: команды реестра + служебные ключи входа/выхода. */
const COMMAND_EVENT_KEYS: AuditEventKey[] = ['platform.command.executed', 'platform.auth.login_success', 'platform.auth.step_up_success', 'platform.auth.step_up_failed', 'platform.auth.session_revoked'];

const json = (v: unknown): unknown => (v === undefined ? null : v === null ? null : JSON.parse(JSON.stringify(v)));

/**
 * Журнал Кабинета — ПРОЕКЦИЯ журнала безопасности (core/audit): бывшие `PlatformAuditEntry`
 * (команды) и `PlatformAccessLog` (чтения) переехали в `security_events` (категория `platform`,
 * видимость — только платформа). Сигнатуры прежние: команда пишется В ТРАНЗАКЦИИ исполнителя
 * (+ квитанция идемпотентности `platform_command_receipts` в той же транзакции); отказы и
 * чтения — вне транзакции, best-effort (икота БД не должна валить Кабинет и ответ 403).
 *
 * `AuditService` — ЛЕНИВО по `DI_TOKENS.AuditService`: журнал регистрирует свои команды в
 * реестре Кабинета, прямая инъекция замкнула бы цикл platform ↔ audit.
 */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);
  private auditRef: AuditService | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly access: PlatformAccessService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get audit(): AuditService {
    this.auditRef ??= this.moduleRef.get<AuditService>(DI_TOKENS.AuditService, { strict: false });
    return this.auditRef;
  }

  private get query(): AuditQueryService {
    return this.moduleRef.get<AuditQueryService>(DI_TOKENS.AuditQueryService, { strict: false });
  }

  private actorOf(entry: Pick<AuditWrite, 'actorId' | 'sessionId' | 'onBehalfOfId' | 'actorRolesSnapshot'>): AuditActorInput {
    return entry.actorId
      ? { kind: 'platform_staff', id: entry.actorId, sessionId: entry.sessionId ?? null, onBehalfOfId: entry.onBehalfOfId ?? null, roles: entry.actorRolesSnapshot ?? null }
      : { kind: 'system' };
  }

  async write(tx: Tx | null, entry: AuditWrite): Promise<{ id: string }> {
    const outcome = OUTCOME_OF[entry.outcome];
    const ctx = { requestId: entry.requestId ?? undefined, ip: entry.ip ?? undefined, userAgent: entry.userAgent ?? undefined, client: 'console' as const };
    const actor = this.actorOf(entry);
    const target = entry.targetType && entry.targetId ? { type: entry.targetType, id: entry.targetId } : null;
    let rec;
    // Служебные ключи входа/выхода — свои события `platform.auth.*` (не команды реестра)
    if (entry.commandKey === PLATFORM_AUDIT_KEYS.login && outcome === 'success') {
      rec = await this.audit.record(tx, { key: 'platform.auth.login_success', op: entry.commandKey, actor, details: {}, ctx });
    } else if (entry.commandKey === PLATFORM_AUDIT_KEYS.stepUp) {
      rec = await this.audit.record(tx, {
        key: outcome === 'success' ? 'platform.auth.step_up_success' : 'platform.auth.step_up_failed',
        op: entry.commandKey,
        outcome,
        reasonCode: entry.errorCode ?? null,
        actor,
        details: {},
        ctx,
      });
    } else if (entry.commandKey === PLATFORM_AUDIT_KEYS.logout) {
      rec = await this.audit.record(tx, { key: 'platform.auth.session_revoked', op: entry.commandKey, actor, details: { by: 'self', sessions: 1 }, ctx });
    } else {
      rec = await this.audit.record(tx, {
        key: 'platform.command.executed',
        op: entry.commandKey,
        outcome,
        reasonCode: entry.errorCode ?? null,
        actor,
        target,
        workspaceId: entry.targetWorkspaceId ?? null,
        details: {
          version: entry.commandVersion ?? 1,
          input: json(entry.input),
          inputHash: entry.inputHash ?? null,
          before: json(entry.before),
          after: json(entry.after),
          error: entry.errorCode ?? null,
          readOnly: entry.readOnly ?? false,
          risk: entry.risk ?? 'low',
          reason: entry.reason ?? null,
          ticketRef: entry.ticketRef ?? null,
          approvalId: entry.approvalId ?? null,
          stepUpAt: entry.stepUpAt ? entry.stepUpAt.toISOString() : null,
          dryRun: entry.dryRun ?? false,
          durationMs: Math.max(0, Math.round(entry.durationMs ?? 0)),
          idempotency: entry.idempotencyKey ?? null,
        },
        ...(entry.approvalId ? { ref: { type: 'approval', id: entry.approvalId } } : {}),
        ctx,
      });
    }
    // Квитанция идемпотентности — в той же транзакции: гонка двух повторов упирается в PK
    // квитанции (P2002 → вызывающий отдаёт результат первого)
    if (entry.idempotencyKey && entry.actorId) {
      await (tx ?? this.db).platformCommandReceipt.create({
        data: { actorId: entry.actorId, commandKey: entry.commandKey, idempotencyKey: entry.idempotencyKey, inputHash: entry.inputHash ?? null, eventId: rec.eventId, eventAt: rec.occurredAt },
      });
    }
    return { id: rec.eventId };
  }

  /**
   * Неудачный/заблокированный вход в Кабинет — ДО аутентификации (актор — аноним, субъект —
   * аккаунт, если номер известен). Fail-closed: сбой журнала = отказ входа (как у продукта).
   */
  async authEvent(key: 'platform.auth.login_failed' | 'platform.auth.login_locked', userId: string | null, reasonCode: string, details: { stage?: 'start' | 'otp' }, ip: string | null): Promise<void> {
    await this.audit.record(null, {
      key,
      outcome: 'failure',
      reasonCode,
      subjectUserId: userId,
      actor: { kind: 'anonymous' },
      details: key === 'platform.auth.login_failed' ? { stage: details.stage ?? 'start' } : {},
      ctx: { ip: ip ?? undefined, client: 'console' },
    });
  }

  /** Заявка four-eyes: заведена / решена / отозвана автором (после факта, best-effort). */
  requestEvent(
    key: 'platform.request.created' | 'platform.request.decided' | 'platform.request.withdrawn',
    actor: { userId: string; sessionId?: string | null; requestId?: string | null; ip?: string | null; roles?: PlatformRoleKey[] },
    request: { id: string; commandKey: string },
    decision?: 'approved' | 'rejected',
  ): Promise<unknown> {
    return this.audit.recordBestEffort({
      key,
      op: request.commandKey,
      actor: { kind: 'platform_staff', id: actor.userId, sessionId: actor.sessionId ?? null, roles: actor.roles ?? null },
      target: { type: 'platform_command_request', id: request.id },
      details: key === 'platform.request.decided' ? { command: request.commandKey, decision: decision ?? 'rejected' } : { command: request.commandKey },
      ctx: { requestId: actor.requestId ?? undefined, ip: actor.ip ?? undefined, client: 'console' },
    });
  }

  /** Отказ — вне транзакции, best-effort: журнал не должен уронить ответ 403. */
  async writeDenied(entry: Omit<AuditWrite, 'outcome'>): Promise<void> {
    try {
      await this.write(null, { ...entry, outcome: 'denied' });
    } catch (err) {
      this.logger.warn(`denied audit write failed: ${(err as Error).message}`);
    }
  }

  /** Повтор идемпотентного ключа того же сотрудника (S5): квитанция → событие исполнения. */
  async findByIdempotency(tx: Tx | DatabaseService, actorId: string, commandKey: string, idempotencyKey: string): Promise<{ id: string; inputHash: string | null; before: unknown; after: unknown } | null> {
    const receipt = await tx.platformCommandReceipt.findUnique({ where: { actorId_commandKey_idempotencyKey: { actorId, commandKey, idempotencyKey } } });
    if (!receipt) return null;
    const event = await tx.securityEvent.findFirst({ where: { eventId: receipt.eventId, occurredAt: receipt.eventAt }, select: { details: true } });
    const d = event?.details && typeof event.details === 'object' && !Array.isArray(event.details) ? (event.details as Record<string, unknown>) : {};
    return { id: receipt.eventId, inputHash: receipt.inputHash, before: d.before ?? null, after: d.after ?? null };
  }

  /** Серия отказов за час — порог security-alert владельцам. */
  async deniedInLastHour(actorId: string): Promise<number> {
    return this.audit.count({ key: ['platform.command.executed', 'platform.auth.step_up_failed'], actorId, outcome: 'denied', sinceMs: 3_600_000 });
  }

  /** Журнал чтений — лёгкая вставка вне транзакции запроса, best-effort (с метрикой отказов). */
  logAccess(entry: { actorId: string; kind: PlatformAccessKind; targetType?: string | null; targetId?: string | null; fields?: string[] | null; requestId?: string | null }): void {
    void this.audit.recordBestEffort({
      key: ACCESS_KEY_OF[entry.kind],
      actor: { kind: 'platform_staff', id: entry.actorId },
      target: entry.targetType && entry.targetId ? { type: entry.targetType, id: entry.targetId } : null,
      details: entry.fields?.length ? { fields: entry.fields.slice(0, 32) } : {},
      ctx: { requestId: entry.requestId ?? undefined, client: 'console' },
      // Предпросмотр команды — тоже просмотр данных (бюджет чтений общий)
      evenInPreview: true,
    });
  }

  async accessCount(actorId: string, kind: PlatformAccessKind, sinceMs: number): Promise<number> {
    return this.audit.count({ key: ACCESS_KEY_OF[kind], actorId, sinceMs });
  }

  // ============================================================
  // Чтение журнала (кабинет, вкладка «Команды»)
  // ============================================================

  async list(q: PlatformAuditQuery): Promise<PlatformAuditPageDto> {
    const limit = Math.min(q.limit ?? PLATFORM_LIMITS.auditPageSize, 200);
    const { rows, nextCursor } = await this.query.rows(
      { kind: 'platform', actorId: 'system' },
      {
        keys: COMMAND_EVENT_KEYS,
        actorId: q.actorId,
        targetType: q.targetType,
        targetId: q.targetId,
        op: q.commandKey,
        outcome: q.outcome ? OUTCOME_OF[q.outcome] : undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        cursor: q.cursor,
        limit,
      },
    );
    const people = await this.access.peopleOf(rows.map((r) => r.actorId).filter((x): x is string => !!x));
    return { items: rows.map((r) => this.toDto(r, people)), nextCursor };
  }

  private toDto(r: AuditRow, people: Map<string, NonNullable<PlatformAuditEntryDto['actor']>>): PlatformAuditEntryDto {
    const d = r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      id: r.eventId,
      occurredAt: r.occurredAt.toISOString(),
      actorId: r.actorId,
      actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
      actorRolesSnapshot: Array.isArray(r.actorRoles) ? (r.actorRoles as PlatformRoleKey[]) : [],
      onBehalfOfId: r.onBehalfOfId,
      sessionId: r.actorSessionId,
      requestId: r.requestId,
      commandKey: r.op ?? r.eventKey,
      commandVersion: typeof d.version === 'number' ? d.version : 1,
      input: d.input ?? null,
      targetType: r.targetType,
      targetId: r.targetId,
      targetWorkspaceId: r.workspaceId,
      before: d.before ?? null,
      after: d.after ?? null,
      outcome: PLATFORM_OUTCOME_OF[auditOutcomeOf(r.outcome)],
      errorCode: r.reasonCode,
      readOnly: d.readOnly === true,
      risk: (str(d.risk) as PlatformRisk | null) ?? 'low',
      reason: str(d.reason),
      ticketRef: str(d.ticketRef),
      approvalId: str(d.approvalId),
      stepUpAt: str(d.stepUpAt),
      idempotencyKey: str(d.idempotency),
      dryRun: d.dryRun === true,
      // Полный IP — только раскрытием (с записью чтения ПДн); в списке — сеть
      ip: r.ipNet,
      userAgent: null,
      durationMs: typeof d.durationMs === 'number' ? d.durationMs : 0,
    };
  }
}
