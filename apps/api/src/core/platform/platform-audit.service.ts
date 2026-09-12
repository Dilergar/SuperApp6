import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PLATFORM_LIMITS,
  type PlatformAccessKind,
  type PlatformAuditEntryDto,
  type PlatformAuditOutcome,
  type PlatformAuditPageDto,
  type PlatformAuditQuery,
  type PlatformRisk,
  type PlatformRoleKey,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { PlatformAccessService } from './platform-access.service';

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

const json = (v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  v === undefined || v === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);

/**
 * Append-only журнал команд (триггер в БД роняет UPDATE/DELETE) + лёгкий журнал чтений.
 * Запись команды идёт В ТРАНЗАКЦИИ исполнителя; отказы — вне транзакции.
 */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: PlatformAccessService,
  ) {}

  async write(tx: Tx | null, entry: AuditWrite): Promise<{ id: string }> {
    const db = tx ?? this.db;
    const row = await db.platformAuditEntry.create({
      data: {
        actorId: entry.actorId,
        actorRolesSnapshot: (entry.actorRolesSnapshot ?? []) as Prisma.InputJsonValue,
        onBehalfOfId: entry.onBehalfOfId ?? null,
        sessionId: entry.sessionId ?? null,
        requestId: entry.requestId ?? null,
        commandKey: entry.commandKey,
        commandVersion: entry.commandVersion ?? 1,
        input: json(entry.input),
        inputHash: entry.inputHash ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetWorkspaceId: entry.targetWorkspaceId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        outcome: entry.outcome,
        errorCode: entry.errorCode ?? null,
        readOnly: entry.readOnly ?? false,
        risk: entry.risk ?? 'low',
        reason: entry.reason ?? null,
        ticketRef: entry.ticketRef ?? null,
        approvalId: entry.approvalId ?? null,
        stepUpAt: entry.stepUpAt ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        dryRun: entry.dryRun ?? false,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        durationMs: entry.durationMs ?? 0,
      },
      select: { id: true },
    });
    return row;
  }

  /** Отказ — вне транзакции, best-effort: журнал не должен уронить ответ 403. */
  async writeDenied(entry: Omit<AuditWrite, 'outcome'>): Promise<void> {
    try {
      await this.write(null, { ...entry, outcome: 'denied' });
    } catch (err) {
      this.logger.warn(`denied audit write failed: ${(err as Error).message}`);
    }
  }

  /** Повтор идемпотентного ключа того же сотрудника (S5). */
  async findByIdempotency(tx: Tx | DatabaseService, actorId: string, commandKey: string, idempotencyKey: string) {
    return tx.platformAuditEntry.findFirst({ where: { actorId, commandKey, idempotencyKey } });
  }

  /** Серия отказов за час — порог security-alert владельцам. */
  async deniedInLastHour(actorId: string): Promise<number> {
    return this.db.platformAuditEntry.count({ where: { actorId, outcome: 'denied', occurredAt: { gt: new Date(Date.now() - 3_600_000) } } });
  }

  /** Журнал чтений — лёгкая вставка вне транзакции запроса, best-effort. */
  logAccess(entry: { actorId: string; kind: PlatformAccessKind; targetType?: string | null; targetId?: string | null; fields?: string[] | null; requestId?: string | null }): void {
    void this.db.platformAccessLog
      .create({
        data: {
          actorId: entry.actorId,
          kind: entry.kind,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          fields: entry.fields ? (entry.fields as Prisma.InputJsonValue) : Prisma.JsonNull,
          requestId: entry.requestId ?? null,
        },
      })
      .catch((err: Error) => this.logger.warn(`access log write failed: ${err.message}`));
  }

  async accessCount(actorId: string, kind: PlatformAccessKind, sinceMs: number): Promise<number> {
    return this.db.platformAccessLog.count({ where: { actorId, kind, occurredAt: { gt: new Date(Date.now() - sinceMs) } } });
  }

  // ============================================================
  // Чтение журнала (кабинет)
  // ============================================================

  async list(q: PlatformAuditQuery): Promise<PlatformAuditPageDto> {
    const limit = Math.min(q.limit ?? PLATFORM_LIMITS.auditPageSize, 200);
    const where: Prisma.PlatformAuditEntryWhereInput = {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.commandKey ? { commandKey: q.commandKey } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    // Keyset-курсор: occurredAt DESC, id DESC (тай-брейк по id)
    const cursor = q.cursor ? this.decodeCursor(q.cursor) : null;
    const rows = await this.db.platformAuditEntry.findMany({
      where: cursor
        ? { AND: [where, { OR: [{ occurredAt: { lt: cursor.at } }, { occurredAt: cursor.at, id: { lt: cursor.id } }] }] }
        : where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const people = await this.access.peopleOf(page.map((r) => r.actorId).filter((x): x is string => !!x));
    const items: PlatformAuditEntryDto[] = page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actorId: r.actorId,
      actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
      actorRolesSnapshot: (r.actorRolesSnapshot as PlatformRoleKey[]) ?? [],
      onBehalfOfId: r.onBehalfOfId,
      sessionId: r.sessionId,
      requestId: r.requestId,
      commandKey: r.commandKey,
      commandVersion: r.commandVersion,
      input: r.input,
      targetType: r.targetType,
      targetId: r.targetId,
      targetWorkspaceId: r.targetWorkspaceId,
      before: r.before,
      after: r.after,
      outcome: r.outcome as PlatformAuditOutcome,
      errorCode: r.errorCode,
      readOnly: r.readOnly,
      risk: r.risk as PlatformRisk,
      reason: r.reason,
      ticketRef: r.ticketRef,
      approvalId: r.approvalId,
      stepUpAt: r.stepUpAt?.toISOString() ?? null,
      idempotencyKey: r.idempotencyKey,
      dryRun: r.dryRun,
      ip: r.ip,
      userAgent: r.userAgent,
      durationMs: r.durationMs,
    }));
    const last = rows.length > limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? this.encodeCursor(last.occurredAt, last.id) : null };
  }

  private encodeCursor(at: Date, id: string): string {
    return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
  }

  private decodeCursor(raw: string): { at: Date; id: string } | null {
    try {
      const [at, id] = Buffer.from(raw, 'base64url').toString().split('|');
      const d = new Date(at);
      return Number.isNaN(d.getTime()) || !id ? null : { at: d, id };
    } catch {
      return null;
    }
  }
}
