import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  AUDIT_ERROR_CODES,
  AUDIT_LIMITS,
  auditOrgFilterKeys,
  isLocale,
  type AuditExportFormat,
  type AuditOrgFilter,
  type OrgAuditExportInput,
  type SecurityEventDto,
} from '@superapp/shared';
import { DEFAULT_LOCALE, type Locale } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { incrWindow } from '../../shared/redis/incr-window';
import { badRequest, tooMany } from '../../shared/errors/api-error';
import type { JwtPayload } from '../../shared/decorators/current-user.decorator';
import { AnalyticsService } from '../analytics/analytics.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FilesRefRegistry } from '../files/files-ref.registry';
import { FilesService } from '../files/files.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AUDIT_EXPORT_REF, AUDIT_JOBS, AUDIT_NOTIFICATION_REF, AUDIT_PLATFORM_EXPORT_REF, AUDIT_QUEUE } from './audit.constants';
import { AuditQueryService, type AuditQueryFilter, type AuditViewer } from './audit.query.service';
import { AuditService } from './audit.service';
import { AuditWorkspaceAccess } from './audit.workspace-access';

export const AUDIT_EXPORT_PROFILE = 'audit_export';

const MIME: Record<AuditExportFormat, string> = { ndjson: 'application/x-ndjson', csv: 'text/csv' };
const PAGE = 200;

/** Колонки CSV — коды и id, без IP, UA и имён (имя человека — по id в продукте). */
const CSV_COLUMNS = ['occurredAt', 'eventId', 'key', 'category', 'severity', 'outcome', 'reasonCode', 'title', 'actorKind', 'actorId', 'subjectUserId', 'targetType', 'targetId', 'country', 'deviceClass', 'client', 'requestId'] as const;

/**
 * Ячейка CSV без «формульной» инъекции (OWASP CSV Injection): значение, начинающееся с
 * `= + - @` / таба / CR, открывается Excel'ем как формула — префиксуем апострофом.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(e: SecurityEventDto): string {
  const actorId = 'id' in e.actor ? (e.actor.id ?? '') : '';
  const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    occurredAt: e.occurredAt,
    eventId: e.eventId,
    key: e.key,
    category: e.category,
    severity: e.severity,
    outcome: e.outcome,
    reasonCode: e.reasonCode,
    title: e.title,
    actorKind: e.actor.kind,
    actorId,
    subjectUserId: e.subject?.id ?? null,
    targetType: e.target?.type ?? null,
    targetId: e.target?.id ?? null,
    country: e.location.country,
    deviceClass: e.device.class,
    client: e.client,
    requestId: e.requestId,
  };
  return CSV_COLUMNS.map((c) => csvCell(cells[c])).join(',');
}

/** Строка NDJSON: событие проекции зрителя без имён людей (только id) — файл уходит наружу. */
function ndjsonRow(e: SecurityEventDto): string {
  const actor = { kind: e.actor.kind, id: 'id' in e.actor ? (e.actor.id ?? null) : null };
  const { subject, target, ...rest } = e;
  return JSON.stringify({ ...rest, actor, subjectUserId: subject?.id ?? null, target: target ? { type: target.type, id: target.id, label: target.label } : null });
}

interface ExportJobPayload {
  exportId: string;
  scope: 'workspace' | 'platform';
  workspaceId?: string;
  userId: string;
  format: AuditExportFormat;
  from: string;
  to: string;
  filter?: AuditOrgFilter;
}

/**
 * Выгрузка журнала безопасности (core/audit): организация — NDJSON/CSV её проекции журнала
 * за окно тарифа на Диск организации (папка «Безопасность», закрытая: видят владелец и
 * админы); Кабинет — всего журнала за период автору команды. Джоб (не запрос): 100 000
 * строк — это минуты. Идемпотентен: событие `data.export` с `target = выгрузка` ставится в
 * ОДНОЙ транзакции с привязкой файла и уведомлением — повтор джоба видит его и выходит.
 */
@Injectable()
export class AuditExportService implements OnModuleInit {
  private readonly logger = new Logger(AuditExportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly fileRefs: FilesRefRegistry,
    private readonly query: AuditQueryService,
    private readonly audit: AuditService,
    private readonly access: AuditWorkspaceAccess,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(AUDIT_JOBS.export, (p) => this.run(p as unknown as ExportJobPayload), { queue: AUDIT_QUEUE, maxAttempts: 3, leaseMs: 15 * 60_000 });
    this.fileRefs.register(
      AUDIT_EXPORT_REF,
      {
        // Журнал организации видят владелец и админы — и его выгрузку тоже
        canView: async (viewerId, workspaceId) => this.access.assertManager(viewerId, workspaceId).then(() => true, () => false),
        canAttach: async () => false,
        blocksDeletion: async () => false,
      },
      { allowedProfiles: [AUDIT_EXPORT_PROFILE], scopedPlace: true },
    );
    this.fileRefs.register(
      AUDIT_PLATFORM_EXPORT_REF,
      {
        // Выгрузка Кабинета — только её автору (через Кабинет); в продукте она не видна никому
        canView: async (viewerId, authorId) => viewerId === authorId,
        canAttach: async () => false,
      },
      { allowedProfiles: [AUDIT_EXPORT_PROFILE], scopedPlace: true },
    );
  }

  // ============================================================
  // Заказ выгрузки организацией
  // ============================================================

  async requestOrg(user: JwtPayload, workspaceId: string, input: OrgAuditExportInput): Promise<{ jobQueued: true }> {
    await this.access.assertManager(user.sub, workspaceId);
    // Тариф: выгрузка — с basic (402 entitlement.feature_locked с «где открыть»)
    await this.entitlements.assertFeature(user.sub, 'audit.export', { type: 'workspace', id: workspaceId });
    const retentionDays = await this.access.retentionDays(workspaceId);
    const from = new Date(input.from);
    const to = new Date(input.to);
    const floor = Date.now() - retentionDays * 86_400_000;
    // Минута допуска: «с начала окна» из формы и сервер считают «сейчас» не в одно мгновение
    if (from.getTime() < floor - 60_000 || to.getTime() > Date.now() + 60_000) {
      throw badRequest('audit.export_range', { days: retentionDays }, { code: AUDIT_ERROR_CODES.exportRange });
    }
    await this.assertDailyLimit(workspaceId);
    const exportId = randomUUID();
    await this.db.$transaction(async (tx) => {
      await this.jobs.enqueue(tx, {
        type: AUDIT_JOBS.export,
        payload: { exportId, scope: 'workspace', workspaceId, userId: user.sub, format: input.format, from: from.toISOString(), to: to.toISOString(), ...(input.filter ? { filter: input.filter } : {}) },
        uniqueKey: `audit-export:${exportId}`,
      });
      await this.analytics.track(tx, 'audit.export.requested', { format: input.format, filter: input.filter ?? 'all' }, { userId: user.sub, workspaceId });
    });
    return { jobQueued: true };
  }

  /** Пять заказов в сутки на организацию (счётчик — Redis; нет Redis — по журналу выгрузок). */
  private async assertDailyLimit(workspaceId: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    let n: number;
    try {
      n = await incrWindow(this.redis.getClient(), `audit:export:${workspaceId}:${day}`, 2 * 86_400);
    } catch {
      n = 1 + (await this.db.securityEvent.count({ where: { eventKey: 'data.export', workspaceId, targetType: AUDIT_EXPORT_REF, occurredAt: { gt: new Date(Date.now() - 86_400_000) } } }));
    }
    if (n > AUDIT_LIMITS.exportsPerDay) {
      throw tooMany('audit.export_daily_limit', undefined, { code: AUDIT_ERROR_CODES.exportDailyLimit, max: AUDIT_LIMITS.exportsPerDay });
    }
  }

  /** Заказ выгрузки Кабинетом (команда `security.export`): синхронно ставит джоб. */
  async requestPlatform(tx: Parameters<JobsService['enqueue']>[0], actorId: string, input: { format: AuditExportFormat; from: string; to: string }): Promise<{ exportId: string }> {
    const exportId = randomUUID();
    await this.jobs.enqueue(tx, {
      type: AUDIT_JOBS.export,
      payload: { exportId, scope: 'platform', userId: actorId, format: input.format, from: input.from, to: input.to },
      uniqueKey: `audit-export:${exportId}`,
    });
    return { exportId };
  }

  // ============================================================
  // Джоб
  // ============================================================

  async run(p: ExportJobPayload): Promise<void> {
    if (!p?.exportId || !p.userId || (p.scope === 'workspace' && !p.workspaceId)) throw new JobDiscardError('audit export: bad payload');
    // Повтор после коммита — выгрузка уже выдана
    const done = await this.db.securityEvent.findFirst({ where: { eventKey: 'data.export', targetType: p.scope === 'workspace' ? AUDIT_EXPORT_REF : AUDIT_PLATFORM_EXPORT_REF, targetId: p.exportId }, select: { id: true } });
    if (done) return;
    const user = await this.db.user.findUnique({ where: { id: p.userId }, select: { locale: true, deletedAt: true } });
    if (!user || user.deletedAt) throw new JobDiscardError('audit export: the requester is gone');
    const locale: Locale = isLocale(user.locale) ? user.locale : DEFAULT_LOCALE;

    let viewer: AuditViewer;
    const filter: AuditQueryFilter = { from: new Date(p.from), to: new Date(p.to), limit: PAGE };
    if (p.scope === 'workspace') {
      // Право и тариф — на момент ИСПОЛНЕНИЯ: админа могли понизить, тариф — сменить
      const allowed = await this.access.assertManager(p.userId, p.workspaceId!).then(() => true, () => false);
      if (!allowed) throw new JobDiscardError('audit export: the requester is no longer a manager');
      viewer = { kind: 'workspace', workspaceId: p.workspaceId!, retentionDays: await this.access.retentionDays(p.workspaceId!) };
      filter.keys = auditOrgFilterKeys(p.filter ?? 'all');
    } else {
      viewer = { kind: 'platform', actorId: p.userId };
    }

    const ext = p.format === 'csv' ? 'csv' : 'ndjson';
    const tmp = join(os.tmpdir(), `sa6-audit-export-${p.exportId}.${ext}`);
    let rows = 0;
    try {
      const out = createWriteStream(tmp, { encoding: 'utf8' });
      const write = async (chunk: string) => {
        if (!out.write(chunk)) await once(out, 'drain');
      };
      if (p.format === 'csv') await write(`﻿${CSV_COLUMNS.join(',')}\n`);
      let cursor: string | undefined;
      while (rows < AUDIT_LIMITS.exportMaxRows) {
        const page = await this.query.rows(viewer, { ...filter, cursor });
        const dtos = await this.query.toDtos(viewer, page.rows, locale);
        for (const e of dtos) {
          if (rows >= AUDIT_LIMITS.exportMaxRows) break;
          await write(`${p.format === 'csv' ? csvRow(e) : ndjsonRow(e)}\n`);
          rows++;
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      out.end();
      await once(out, 'finish');

      const stamp = (iso: string) => iso.slice(0, 10);
      const file = await this.files.ingestLocalFile({
        path: tmp,
        name: `security-log_${stamp(p.from)}_${stamp(p.to)}.${ext}`,
        mime: MIME[p.format],
        profile: AUDIT_EXPORT_PROFILE,
        ownerUserId: p.userId,
        ...(p.scope === 'workspace' ? { ownerType: 'workspace' as const, ownerId: p.workspaceId! } : {}),
        autoName: { key: 'audit.export.fileName', params: { from: stamp(p.from), to: stamp(p.to), ext } },
      });

      await this.db.$transaction(async (tx) => {
        const refType = p.scope === 'workspace' ? AUDIT_EXPORT_REF : AUDIT_PLATFORM_EXPORT_REF;
        const refId = p.scope === 'workspace' ? p.workspaceId! : p.userId;
        // Привязка будит Диск (наблюдатель ссылок): файл организации ляжет в «Безопасность»
        await this.files.linkManyInTx(tx, p.userId, [file.id], refType, refId);
        const ev = await this.audit.record(tx, {
          key: 'data.export',
          actor: p.scope === 'workspace' ? { kind: 'user', id: p.userId } : { kind: 'platform_staff', id: p.userId },
          // Выгрузка Кабинета — действие сотрудника платформы: ни в чью ленту она не ложится
          subjectUserId: p.scope === 'workspace' ? p.userId : null,
          workspaceId: p.scope === 'workspace' ? p.workspaceId! : null,
          target: { type: refType, id: p.exportId },
          details: { source: p.scope === 'workspace' ? 'audit_org' : 'audit_platform', rows, format: p.format },
          ctx: { client: p.scope === 'workspace' ? 'job' : 'console' },
        });
        if (p.scope === 'workspace') {
          await this.notifications.send(tx, {
            type: 'security.org.exportReady',
            to: [{ userId: p.userId }],
            workspaceId: p.workspaceId!,
            payload: { rows },
            ref: { type: AUDIT_NOTIFICATION_REF.workspace, id: `${p.workspaceId}:${ev.id}` },
            reason: 'requested',
          });
        }
      });
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  /** Выгрузки Кабинета этого сотрудника (последние 20) — вкладка «Целостность». */
  async platformExports(actorId: string): Promise<Array<{ fileId: string; name: string; size: number; createdAt: string }>> {
    const links = await this.db.fileLink.findMany({ where: { refType: AUDIT_PLATFORM_EXPORT_REF, refId: actorId }, orderBy: { createdAt: 'desc' }, take: 20, select: { fileId: true } });
    if (!links.length) return [];
    const files = await this.db.fileObject.findMany({ where: { id: { in: links.map((l) => l.fileId) }, status: 'ready' }, select: { id: true, name: true, size: true, createdAt: true } });
    return files
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((f) => ({ fileId: f.id, name: f.name, size: Number(f.size), createdAt: f.createdAt.toISOString() }));
  }

  /** Ссылка на скачивание своей выгрузки Кабинета (короткая, системная). */
  async platformExportUrl(actorId: string, fileId: string): Promise<{ url: string } | null> {
    const link = await this.db.fileLink.findFirst({ where: { refType: AUDIT_PLATFORM_EXPORT_REF, refId: actorId, fileId }, select: { fileId: true } });
    if (!link) return null;
    const u = await this.files.buildSystemDownloadUrl(fileId);
    return { url: u.url };
  }
}
