import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type SecurityAlert } from '@prisma/client';
import {
  AUDIT_ALERT_RESOLUTIONS,
  AUDIT_ALERT_STATUSES,
  AUDIT_ERROR_CODES,
  AUDIT_SEVERITIES,
  type AuditAlertResolution,
  type AuditAlertStatus,
  type AuditEventKey,
  type AuditPersonDto,
  type AuditSeverity,
  type SecurityAlertDto,
  type SecurityAlertPageDto,
  type SecurityAlertSummaryDto,
  type SecurityAlertsQuery,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { conflict, notFound } from '../../shared/errors/api-error';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformNotifier, type PlatformSecurityEvent } from '../platform/platform.notifications';
import { AUDIT_NOTIFICATION_REF } from './audit.constants';
import { AuditMetrics } from './audit.metrics';
import { AuditService } from './audit.service';

type Tx = Prisma.TransactionClient;

/** Виды детекций (ключ события — `detect.<kind>`). */
export type AuditDetectKind =
  | 'bruteforce_account'
  | 'bruteforce_ip'
  | 'password_spray'
  | 'credential_stuffing'
  | 'otp_fatigue'
  | 'mass_export'
  | 'dormant_login'
  | 'digest_mismatch'
  | 'digest_gap'
  | 'audit_degraded'
  | 'idor_probing'
  | 'malware_burst';

/** Ключ события детекции — явной картой: компилятор сверяет каждый с реестром, страж видит литерал. */
const DETECT_EVENT_KEY: Record<AuditDetectKind, AuditEventKey> = {
  bruteforce_account: 'detect.bruteforce_account',
  bruteforce_ip: 'detect.bruteforce_ip',
  password_spray: 'detect.password_spray',
  credential_stuffing: 'detect.credential_stuffing',
  otp_fatigue: 'detect.otp_fatigue',
  mass_export: 'detect.mass_export',
  dormant_login: 'detect.dormant_login',
  digest_mismatch: 'detect.digest_mismatch',
  digest_gap: 'detect.digest_gap',
  audit_degraded: 'detect.audit_degraded',
  idor_probing: 'detect.idor_probing',
  malware_burst: 'detect.malware_burst',
};

/** Сводка находки — детали события `detect.*` (коды и счётчики, без людей и адресов). */
export interface AuditFinding {
  events: number;
  accounts?: number;
  networks?: number;
  rows?: number;
  windowMin: number;
  failureRatePct?: number;
}

export interface AuditRaiseInput {
  kind: AuditDetectKind;
  severity: AuditSeverity;
  /** Субъект / сеть / организация — то, по чему тревога одна */
  dedupeKey: string;
  subjectUserId?: string | null;
  workspaceId?: string | null;
  ipHmac?: string | null;
  /** id событий-улик (bigint строками) */
  evidence?: string[];
  /** Детали события `detect.<kind>` по схеме реестра (у деградации журнала — свои: `failures`) */
  finding: AuditFinding | { failures: number; windowMin: number };
  /** CRITICAL — сигнал владельцам платформы этим событием */
  platformEvent?: PlatformSecurityEvent;
  /** Находка внутри организации — уведомить её владельца и админов (нужен `workspaceId`) */
  orgNotice?: AuditOrgNotice;
}

/** Уведомление организации о находке: ссылка на событие-причину её журнала (обязано быть `vis_workspace`). */
export interface AuditOrgNotice {
  /** id (bigint строкой) события-причины, видимого организации */
  eventId: string;
  rows: number;
  windowMin: number;
  /** Кто выгружал — ему о самом себе не пишем */
  actorId: string | null;
}

const isOf = <T extends string>(list: readonly T[], v: string | null): v is T => v !== null && (list as readonly string[]).includes(v);

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  try {
    const [at, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const d = new Date(at ?? '');
    if (Number.isNaN(d.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at: d, id };
  } catch {
    return null;
  }
}

/**
 * Тревоги детекций — рабочая очередь безопасности платформы (не журнал: журнал — события
 * `detect.*`). Чтение и закрытие; открытие/дедупликацию ведут детекции (`audit.detections.ts`).
 * Права решает вызывающий (консоль — `security.read`, закрытие — команда `security.alert.close`).
 */
@Injectable()
export class AuditAlertsService {
  private readonly logger = new Logger(AuditAlertsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifier: PlatformNotifier,
    private readonly notifications: NotificationsService,
    private readonly metrics: AuditMetrics,
  ) {}

  /**
   * Поднять тревогу: ОДНА незакрытая на (вид, ключ) — атомарный upsert по партиальному
   * уникуму (`security_alerts_open_uq`): гонка двух инстансов не даёт двух тревог и не
   * роняет транзакцию P2002. Повтор наращивает `hits` и улики (≤ 50). Событие `detect.*` и
   * сигнал владельцам — только у НОВОЙ тревоги (повтор — не новая находка).
   */
  async raise(input: AuditRaiseInput): Promise<{ id: string; fresh: boolean }> {
    const now = new Date();
    // Улики — id строк журнала; '0' — сигнал без строки (попытка во время блокировки), не улика
    const ids = (input.evidence ?? []).filter((v) => /^\d{1,19}$/.test(v) && v !== '0').slice(0, 50);
    const evidence = JSON.stringify(ids);
    const rows = await this.db.$queryRaw<Array<{ id: string; fresh: boolean }>>`
      INSERT INTO security_alerts (id, kind, severity, dedupe_key, subject_user_id, workspace_id, ip_hmac, evidence, hits, status, opened_at, updated_at)
      VALUES (${randomUUID()}, ${input.kind}, ${input.severity}, ${input.dedupeKey.slice(0, 300)},
              ${input.subjectUserId ?? null}::uuid, ${input.workspaceId ?? null}::uuid, ${input.ipHmac ?? null},
              ${evidence}::jsonb, 1, 'open', ${utcTs(now)}, ${utcTs(now)})
      ON CONFLICT (kind, dedupe_key) WHERE status IN ('open', 'ack')
      DO UPDATE SET hits = security_alerts.hits + 1,
        evidence = CASE WHEN jsonb_array_length(security_alerts.evidence) >= 50 THEN security_alerts.evidence
                        ELSE security_alerts.evidence || EXCLUDED.evidence END,
        updated_at = EXCLUDED.updated_at
      RETURNING id, (xmax = 0) AS fresh`;
    const row = rows[0];
    if (!row) throw new Error('audit alert upsert returned nothing');
    if (!row.fresh) return { id: row.id, fresh: false };
    this.metrics.detections.inc({ rule: input.kind });
    try {
      await this.audit.record(null, {
        key: DETECT_EVENT_KEY[input.kind],
        actor: { kind: 'system' },
        subjectUserId: input.subjectUserId ?? null,
        workspaceId: input.workspaceId ?? null,
        target: { type: 'security_alert', id: row.id },
        details: input.finding,
        ...(ids[0] ? { ref: { type: 'security_event', id: ids[0] } } : {}),
      });
    } catch (err) {
      this.logger.error(`detect.${input.kind} event was not recorded: ${(err as Error).message}`);
    }
    if (input.platformEvent) {
      const n = 'events' in input.finding ? input.finding.events : input.finding.failures;
      await this.notifier.securityAlert(null, null, input.platformEvent, `${input.kind}:${n}`);
    }
    if (input.orgNotice && input.workspaceId) {
      await this.notifyOrganization(input.workspaceId, input.orgNotice).catch((err: unknown) =>
        this.logger.error(`organization notice of ${input.kind} was not sent: ${(err as Error).message}`),
      );
    }
    return { id: row.id, fresh: true };
  }

  /**
   * Владелец и админы организации узнают о находке внутри своей организации (массовая выгрузка).
   * Ссылка — на событие-причину в ЖУРНАЛЕ ОРГАНИЗАЦИИ (оно обязано быть `vis_workspace`: иначе
   * фанаут отсеет адресатов по праву видеть ссылку); сама тревога остаётся платформенной.
   * Актор находки уведомления о себе не получает.
   */
  private async notifyOrganization(workspaceId: string, notice: AuditOrgNotice): Promise<void> {
    const managers = await this.db.userRole.findMany({
      where: { context: 'workspace', tenantId: workspaceId, isActive: true, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    });
    const to = [...new Set(managers.map((m) => m.userId))].filter((id) => id !== notice.actorId).map((userId) => ({ userId }));
    if (!to.length) return;
    await this.notifications.send(null, {
      type: 'security.org.massExport',
      to,
      workspaceId,
      payload: { rows: notice.rows, minutes: notice.windowMin },
      ref: { type: AUDIT_NOTIFICATION_REF.workspace, id: `${workspaceId}:${notice.eventId}` },
      reason: 'manager',
    });
  }

  async list(q: SecurityAlertsQuery): Promise<SecurityAlertPageDto> {
    const limit = Math.min(q.limit ?? 50, 200);
    const cursor = decodeCursor(q.cursor);
    const and: Prisma.SecurityAlertWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (cursor) and.push({ OR: [{ openedAt: { lt: cursor.at } }, { openedAt: cursor.at, id: { lt: cursor.id } }] });
    const rows = await this.db.securityAlert.findMany({ where: { AND: and }, orderBy: [{ openedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : null;
    return { items: await this.toDtos(page), nextCursor: last ? encodeCursor(last.openedAt, last.id) : null };
  }

  /** Сводка незакрытой очереди: счётчик вкладки «Тревоги» (индекс `(status, opened_at)`). */
  async summary(): Promise<SecurityAlertSummaryDto> {
    const rows = await this.db.securityAlert.groupBy({ by: ['status', 'severity'], where: { status: { in: ['open', 'ack'] } }, _count: { _all: true } });
    const out: SecurityAlertSummaryDto = { open: 0, ack: 0, critical: 0 };
    for (const r of rows) {
      const n = r._count._all;
      if (r.status === 'open') out.open += n;
      else out.ack += n;
      if (r.severity === 'critical') out.critical += n;
    }
    return out;
  }

  /** Открытые тревоги субъекта или организации (панели карточки 360). */
  async openFor(where: { subjectUserId?: string; workspaceId?: string }, take = 10): Promise<SecurityAlertDto[]> {
    const rows = await this.db.securityAlert.findMany({
      where: { status: { in: ['open', 'ack'] }, ...(where.subjectUserId ? { subjectUserId: where.subjectUserId } : {}), ...(where.workspaceId ? { workspaceId: where.workspaceId } : {}) },
      orderBy: { openedAt: 'desc' },
      take,
    });
    return this.toDtos(rows);
  }

  /** Закрыть тревогу с итогом — status-guarded: гонка двух сотрудников даёт одно закрытие. */
  async closeTx(tx: Tx, alertId: string, resolution: AuditAlertResolution, actorId: string): Promise<{ kind: string; before: AuditAlertStatus }> {
    const row = await tx.securityAlert.findUnique({ where: { id: alertId }, select: { kind: true, status: true } });
    if (!row) throw notFound('audit.alert_not_found', undefined, { code: AUDIT_ERROR_CODES.alertNotFound });
    const { count } = await tx.securityAlert.updateMany({
      where: { id: alertId, status: { in: ['open', 'ack'] } },
      data: { status: 'closed', resolution, closedAt: new Date(), assigneeId: actorId },
    });
    if (!count) throw conflict('audit.alert_closed', undefined, { code: AUDIT_ERROR_CODES.alertClosed });
    return { kind: row.kind, before: isOf(AUDIT_ALERT_STATUSES, row.status) ? row.status : 'open' };
  }

  async toDtos(rows: SecurityAlert[]): Promise<SecurityAlertDto[]> {
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.subjectUserId).filter((v): v is string => !!v))];
    const people = ids.length ? await this.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, avatar: true } }) : [];
    const byId = new Map<string, AuditPersonDto>(people.map((p) => [p.id, { id: p.id, firstName: p.firstName, lastName: p.lastName, avatar: p.avatar }]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      severity: (isOf(AUDIT_SEVERITIES, r.severity) ? r.severity : 'high') as AuditSeverity,
      status: isOf(AUDIT_ALERT_STATUSES, r.status) ? r.status : 'open',
      subject: r.subjectUserId ? (byId.get(r.subjectUserId) ?? null) : null,
      subjectUserId: r.subjectUserId,
      workspaceId: r.workspaceId,
      ipHmac: r.ipHmac,
      evidence: Array.isArray(r.evidence) ? (r.evidence as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 50) : [],
      hits: r.hits,
      assigneeId: r.assigneeId,
      resolution: isOf(AUDIT_ALERT_RESOLUTIONS, r.resolution) ? r.resolution : null,
      openedAt: r.openedAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    }));
  }
}
