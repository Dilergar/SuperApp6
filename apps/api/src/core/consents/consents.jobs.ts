import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CONSENT_KINDS, type ConsentDocumentKey } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobSnoozeError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformNotifier } from '../platform/platform.notifications';
import { CONSENTS_FANOUT_BATCH, CONSENTS_JOBS, CONSENTS_QUEUE, CONSENT_DOCUMENT_REF_TYPE } from './consents.constants';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsIncidentsService } from './consents.incidents.service';

/**
 * Фон движка согласий:
 *  - `consents.version.activate` — в момент `effectiveFrom`: прошлые версии → `superseded`
 *    (шлюз от джоба не зависит — его правда даты; джоб лишь приводит статусы в порядок);
 *  - `consents.version.notify` — уведомление о новой версии: людям — порциями по курсору
 *    (джоб перезаводит сам себя, одна порция = одна короткая транзакция), организациям —
 *    владельцу и админам;
 *  - `pd.incident.deadline_alert` — тревога владельцам кабинета за 4 часа до срока.
 * Крон — партиции учёта действий на три месяца вперёд.
 */
@Injectable()
export class ConsentsJobs implements OnModuleInit {
  private readonly logger = new Logger(ConsentsJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly documents: ConsentsDocumentsService,
    private readonly incidents: ConsentsIncidentsService,
    private readonly notifications: NotificationsService,
    private readonly platformNotifier: PlatformNotifier,
  ) {}

  onModuleInit(): void {
    const opts = { queue: CONSENTS_QUEUE, maxAttempts: 10, queueConcurrency: 1 };
    this.registry.register(CONSENTS_JOBS.versionActivate, (p) => this.versionActivate(p), { ...opts, maxAttempts: 20 });
    this.registry.register(CONSENTS_JOBS.newVersionFanout, (p) => this.newVersionFanout(p), opts);
    this.registry.register(CONSENTS_JOBS.incidentDeadlineAlert, (p) => this.incidentDeadlineAlert(p), opts);
  }

  async versionActivate(payload: Record<string, unknown>): Promise<void> {
    const versionId = typeof payload.versionId === 'string' ? payload.versionId : null;
    if (!versionId) throw new JobDiscardError('consents.version.activate: versionId missing');
    const res = await this.documents.activate(versionId);
    // Часы инстанса отстали от момента постановки — подождать, попытку не тратить
    if (res === 'too_early') throw new JobSnoozeError(60_000, 'effectiveFrom not reached yet');
  }

  /**
   * Одна порция адресатов → одно событие уведомления → следующая порция отдельным джобом.
   * Идемпотентность — `idempotencyKey` события (версия + курсор порции): повтор порции после
   * сбоя не даёт второго уведомления тем же людям.
   */
  async newVersionFanout(payload: Record<string, unknown>): Promise<void> {
    const versionId = typeof payload.versionId === 'string' ? payload.versionId : null;
    if (!versionId) throw new JobDiscardError('consents.version.notify: versionId missing');
    const cursor = typeof payload.cursor === 'string' ? payload.cursor : null;
    const v = await this.db.consentVersion.findUnique({ where: { id: versionId }, select: { id: true, documentKey: true, version: true, status: true, effectiveFrom: true } });
    if (!v || v.status === 'draft' || v.status === 'withdrawn' || !v.effectiveFrom) return;
    const key = v.documentKey as ConsentDocumentKey;
    const kind = CONSENT_KINDS[key];
    if (!kind) return;
    const common = {
      payload: { documentKey: key, documentLabelKey: `shell.consents.documents.${key}`, version: v.version, effectiveFromIso: v.effectiveFrom.toISOString() },
      ref: { type: CONSENT_DOCUMENT_REF_TYPE, id: key },
      reason: 'system' as const,
    };

    if (kind.subject === 'workspace') {
      // Владелец и админы живых организаций — порциями по id организации
      const workspaces = await this.db.workspace.findMany({ where: { archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: CONSENTS_FANOUT_BATCH });
      for (const ws of workspaces) {
        const roles = await this.db.userRole.findMany({ where: { context: 'workspace', tenantId: ws.id, isActive: true, role: { in: ['owner', 'admin'] } }, select: { userId: true } });
        const to = [...new Set(roles.map((r) => r.userId))].map((userId) => ({ userId }));
        if (!to.length) continue;
        await this.notifications.send(null, { ...common, type: 'consents.workspace.newVersion', to, workspaceId: ws.id, idempotencyKey: `consents:new:${v.id}:${ws.id}` });
      }
      if (workspaces.length === CONSENTS_FANOUT_BATCH) await this.next(v.id, workspaces[workspaces.length - 1]!.id);
      return;
    }

    const users = await this.db.user.findMany({
      where: { kind: 'person', deletedAt: null, deletionScheduledAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: CONSENTS_FANOUT_BATCH,
    });
    if (users.length) {
      await this.notifications.send(null, { ...common, type: 'consents.newVersion', to: users.map((u) => ({ userId: u.id })), idempotencyKey: `consents:new:${v.id}:${cursor ?? 'start'}` });
    }
    if (users.length === CONSENTS_FANOUT_BATCH) await this.next(v.id, users[users.length - 1]!.id);
  }

  private async next(versionId: string, cursor: string): Promise<void> {
    await this.jobs.enqueue(null, { type: CONSENTS_JOBS.newVersionFanout, payload: { versionId, cursor }, uniqueKey: `notify:${versionId}:${cursor}` });
  }

  async incidentDeadlineAlert(payload: Record<string, unknown>): Promise<void> {
    const incidentId = typeof payload.incidentId === 'string' ? payload.incidentId : null;
    if (!incidentId) throw new JobDiscardError('pd.incident.deadline_alert: incidentId missing');
    const incident = await this.incidents.dueForAlert(incidentId);
    if (!incident) return;
    // Клейм — ПОСЛЕ эффекта: упавшая отправка повторится, а не оставит инцидент без тревоги
    await this.platformNotifier.securityAlert(null, null, 'pdIncidentDeadline', `${incident.kind} · ${incident.notifyDeadlineAt.toISOString()}`);
    await this.incidents.markAlerted(incidentId);
  }

}
