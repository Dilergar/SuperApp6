import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { AuditEventKey, KeyActorLiteDto, KeyAuditEntryDto, KeyAuditPage, KeyJournalQuery } from '@superapp/shared';
import { AUDIT_LIMITS, KEYS_LIMITS } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { DI_TOKENS } from '../../shared/di-tokens';
import type { AuditActorInput, AuditService } from '../audit/audit.service';
import type { AuditQueryService, AuditRow } from '../audit/audit.query.service';
import { AUDIT_PLATFORM_ONLY_DETAILS, auditActorKindOf } from '../audit/audit.codes';
import { urlLabel } from '../audit/audit.redact';

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
  /** Владелец личного ключа — событие видно ему в «Безопасности» (субъект ленты) */
  subjectUserId?: string | null;
  subjectType: string;
  subjectId: string;
  subjectName?: string | null;
  action: string;
  /** Обоснование админа / сотрудника (свободный текст) — уходит в детали `note` */
  reason?: string | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Действие движка ключей → ключ события журнала безопасности. Явная таблица (а не шаблон
 * строки): так ключ виден стражу `check:audit` литералом и не собирается из данных.
 */
export const KEYS_AUDIT_KEY_OF: Readonly<Record<string, AuditEventKey>> = {
  'api_key.created': 'keys.api_key.created',
  'api_key.updated': 'keys.api_key.updated',
  'api_key.rotated': 'keys.api_key.rotated',
  'api_key.revoked': 'keys.api_key.revoked',
  'api_key.leaked': 'keys.api_key.leaked',
  'bot.created': 'keys.bot.created',
  'bot.updated': 'keys.bot.updated',
  'bot.frozen': 'keys.bot.frozen',
  'bot.unfrozen': 'keys.bot.unfrozen',
  'bot.archived': 'keys.bot.archived',
  'policy.updated': 'keys.policy.changed',
  'webhook.endpoint.created': 'keys.webhook.created',
  'webhook.endpoint.updated': 'keys.webhook.updated',
  'webhook.endpoint.enabled': 'keys.webhook.enabled',
  'webhook.endpoint.disabled': 'keys.webhook.disabled',
  'webhook.endpoint.deleted': 'keys.webhook.deleted',
  'webhook.endpoint.secret_rotated': 'keys.webhook.secret_rotated',
  'webhook.endpoint.verified': 'keys.webhook.verified',
  'webhook.endpoint.signature_audit': 'keys.webhook.signature_audit',
  'crypto_key.created': 'keys.crypto.key_created',
  'key_version.created': 'keys.crypto.version_created',
  'key_version.activated': 'keys.crypto.version_activated',
  'key_version.disabled': 'keys.crypto.version_disabled',
  'key_version.enabled': 'keys.crypto.version_enabled',
  'key_version.destroy_scheduled': 'keys.crypto.version_destroy_scheduled',
  'key_version.destroyed': 'keys.crypto.version_destroyed',
  'key_version.compromised': 'keys.crypto.version_compromised',
  'scope.frozen': 'keys.crypto.scope_frozen',
  'scope.unfrozen': 'keys.crypto.scope_unfrozen',
  'scope.rewrapped': 'keys.crypto.scope_rewrapped',
  'root.rotation_started': 'keys.crypto.root_rotation_started',
  'root.rotated': 'keys.crypto.root_rotated',
  'blind_index.rotated': 'keys.crypto.blind_index_rotated',
};

/** Ключи событий, у схемы которых есть `note` (обоснование админа). */
const WITH_NOTE = new Set<AuditEventKey>(['keys.api_key.revoked', 'keys.api_key.leaked', 'keys.bot.unfrozen', ...Object.values(KEYS_AUDIT_KEY_OF).filter((k) => k.startsWith('keys.crypto.'))]);

const ACTOR_KIND: Record<string, AuditActorInput['kind']> = { user: 'user', bot: 'bot', system: 'system', platform: 'platform_staff' };
const KEYS_EVENT_KEYS = [...new Set(Object.values(KEYS_AUDIT_KEY_OF))];

/**
 * Журнал действий с ключами — ПРОЕКЦИЯ журнала безопасности (core/audit): бывший
 * `KeyAuditEntry` переехал в `security_events` (категория `keys`). Запись идёт В ТРАНЗАКЦИИ
 * действия (откат = записи нет); `tx = null` — крон/пост-коммит. Ключевого материала и
 * секретов здесь нет никогда: только «кто, что, когда, почему». Вкладка «Журнал» реестра
 * ключей организации читает ту же ленту в прежней форме DTO.
 *
 * `AuditService` — ЛЕНИВО по `DI_TOKENS.AuditService`: журнал сам тянет keystore (envelope,
 * HMAC, подпись), прямая инъекция замкнула бы цикл провайдеров keys ↔ audit.
 */
@Injectable()
export class KeysAuditService {
  private auditRef: AuditService | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get audit(): AuditService {
    this.auditRef ??= this.moduleRef.get<AuditService>(DI_TOKENS.AuditService, { strict: false });
    return this.auditRef;
  }

  private get query(): AuditQueryService {
    return this.moduleRef.get<AuditQueryService>(DI_TOKENS.AuditQueryService, { strict: false });
  }

  async log(tx: Tx | null, e: KeyAuditInput): Promise<void> {
    const raw = e.details ?? {};
    // Отзыв со сканера утечек — своё событие (critical), а не обычный отзыв
    const action = e.action === 'api_key.revoked' && raw.reason === 'leaked' ? 'api_key.leaked' : e.action === 'webhook.endpoint.disabled' && raw.reason === 'signature_audit' ? 'webhook.endpoint.signature_audit' : e.action;
    const key = KEYS_AUDIT_KEY_OF[action];
    if (!key) throw new Error(`keys audit: no security event for action "${e.action}" — map it in KEYS_AUDIT_KEY_OF`);
    const details: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === null || v === undefined) continue;
      if (key === 'keys.api_key.leaked' && k === 'reason') continue;
      if (key === 'keys.webhook.signature_audit' && k === 'reason') continue;
      // Скоупы бота — счётчиком (список сервисов живёт в самом боте)
      if (k === 'scopes' && Array.isArray(v)) details.scopes = v.length;
      else if (k === 'requireIpAllowlist') details.requireAllowlist = v;
      else details[k] = v;
    }
    if (e.reason && WITH_NOTE.has(key)) details.note = e.reason;
    const label = e.subjectType === 'webhook_endpoint' ? urlLabel(e.subjectName) : (e.subjectName ?? null);
    const actorKind = ACTOR_KIND[e.actorKind ?? 'user'] ?? 'system';
    await this.audit.record(tx, {
      key,
      op: e.action,
      workspaceId: e.workspaceId ?? null,
      subjectUserId: e.subjectUserId ?? null,
      actor: e.actorId || actorKind !== 'user' ? { kind: actorKind, id: e.actorId ?? null } : undefined,
      target: { type: e.subjectType, id: e.subjectId, label },
      details: details as never,
      ...(e.ip ? { ctx: { ip: e.ip } } : {}),
    });
  }

  /** Лента журнала организации (keyset по времени). Права проверил контроллер. */
  async list(workspaceId: string, q: KeyJournalQuery): Promise<KeyAuditPage> {
    const limit = q.limit ?? KEYS_LIMITS.journalPageSize;
    // Вкладка «Журнал» ключей существовала до тарифов журнала — окно не режется тарифом:
    // вся история ключей организации в пределах срока хранения
    const { rows, nextCursor } = await this.query.rows(
      { kind: 'workspace', workspaceId, retentionDays: AUDIT_LIMITS.retentionYears * 366 },
      { keys: KEYS_EVENT_KEYS, targetType: q.subjectType, targetId: q.subjectId, cursor: q.cursor, limit },
    );
    // Сотрудник платформы в журнале организации — «Платформа» без личности (id и имя не уходят)
    const actorIds = rows.filter((r) => auditActorKindOf(r.actorKind) !== 'platform_staff').map((r) => r.actorId);
    const actors = await keyActorsLite(this.db, [...new Set(actorIds.filter((v): v is string => !!v))]);
    return { items: rows.map((r) => this.toDto(r)), nextCursor, actors };
  }

  /** Строка ленты организации: проекция зрителя-организации (как `AuditQueryService.toDtos`). */
  private toDto(r: AuditRow): KeyAuditEntryDto {
    const kind = auditActorKindOf(r.actorKind);
    const raw = r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : null;
    const details = raw ? Object.fromEntries(Object.entries(raw).filter(([k]) => !AUDIT_PLATFORM_ONLY_DETAILS.has(k))) : null;
    return {
      id: r.id.toString(),
      occurredAt: r.occurredAt.toISOString(),
      actorId: kind === 'platform_staff' ? null : r.actorId,
      actorKind: kind === 'platform_staff' ? 'platform' : kind === 'bot' ? 'bot' : kind === 'user' ? 'user' : 'system',
      action: r.op ?? r.eventKey,
      subjectType: r.targetType ?? '',
      subjectId: r.targetId ?? '',
      subjectName: r.targetLabel,
      reason: typeof details?.note === 'string' ? details.note : null,
      details,
    };
  }
}
