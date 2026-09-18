import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { KeyActorLiteDto, KeyAuditEntryDto, KeyAuditPage, KeyJournalQuery } from '@superapp/shared';
import { KEYS_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';

type Tx = Prisma.TransactionClient;

/** Лайт-профили людей и ботов по id (PersonChip/BotChip на клиенте). Удалённые — пропускаются. */
export async function keyActorsLite(db: { user: DatabaseService['user'] }, ids: string[]): Promise<Record<string, KeyActorLiteDto>> {
  if (!ids.length) return {};
  const rows = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, avatar: true, kind: true } });
  return Object.fromEntries(rows.map((u) => [u.id, { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar, kind: u.kind === 'bot' ? 'bot' : 'person' } satisfies KeyActorLiteDto]));
}

export interface KeyAuditInput {
  actorId?: string | null;
  /** user | bot | system | platform */
  actorKind?: string;
  workspaceId?: string | null;
  subjectType: string;
  subjectId: string;
  subjectName?: string | null;
  action: string;
  reason?: string | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Журнал действий с ключами — append-only (триггеры в миграции). Пишется В ТРАНЗАКЦИИ
 * действия (откат = записи нет); `tx = null` — крон/пост-коммит. Ключевого материала и
 * секретов здесь нет никогда: только «кто, что, когда, почему».
 */
@Injectable()
export class KeysAuditService {
  constructor(private readonly db: DatabaseService) {}

  async log(tx: Tx | null, e: KeyAuditInput): Promise<void> {
    const client = tx ?? this.db;
    await client.keyAuditEntry.create({
      data: {
        actorId: e.actorId ?? null,
        actorKind: e.actorKind ?? 'user',
        workspaceId: e.workspaceId ?? null,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        subjectName: e.subjectName ?? null,
        action: e.action,
        reason: e.reason ?? null,
        ip: e.ip ?? null,
        details: e.details === undefined || e.details === null ? Prisma.JsonNull : (e.details as Prisma.InputJsonValue),
      },
    });
  }

  /** Лента журнала организации (keyset по id DESC). Права проверил контроллер. */
  async list(workspaceId: string, q: KeyJournalQuery): Promise<KeyAuditPage> {
    const limit = q.limit ?? KEYS_LIMITS.journalPageSize;
    // Курсор — id строки; чужая строка (`BigInt('abc')` бросает SyntaxError → 500) читается как «с начала»
    const cursor = q.cursor && /^\d{1,18}$/.test(q.cursor) ? BigInt(q.cursor) : null;
    const rows = await this.db.keyAuditEntry.findMany({
      where: {
        workspaceId,
        ...(q.subjectType ? { subjectType: q.subjectType } : {}),
        ...(q.subjectId ? { subjectId: q.subjectId } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const actors = await keyActorsLite(this.db, [...new Set(page.map((r) => r.actorId).filter((v): v is string => !!v))]);
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
      actors,
    };
  }

  /** Записи по предмету без привязки к организации (личные ключи человека). */
  async listForSubject(subjectType: string, subjectId: string, limit = 50): Promise<KeyAuditEntryDto[]> {
    const rows = await this.db.keyAuditEntry.findMany({ where: { subjectType, subjectId }, orderBy: { id: 'desc' }, take: limit });
    return rows.map((r) => this.toDto(r));
  }

  private toDto(r: {
    id: bigint;
    occurredAt: Date;
    actorId: string | null;
    actorKind: string;
    action: string;
    subjectType: string;
    subjectId: string;
    subjectName: string | null;
    reason: string | null;
    details: Prisma.JsonValue;
  }): KeyAuditEntryDto {
    return {
      id: String(r.id),
      occurredAt: r.occurredAt.toISOString(),
      actorId: r.actorId,
      actorKind: r.actorKind,
      action: r.action,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      reason: r.reason,
      details: r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : null,
    };
  }
}
