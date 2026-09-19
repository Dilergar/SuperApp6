import { Injectable } from '@nestjs/common';
import { Prisma, type PdIncident, type PdIncidentEvent } from '@prisma/client';
import {
  PD_INCIDENT_LIMITS,
  addBusinessDays,
  type PdIncidentDto,
  type PdIncidentEventType,
  type PdIncidentKind,
  type PdIncidentOpenInput,
  type PdIncidentStatus,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, notFound } from '../../shared/errors/api-error';
import { JobsService } from '../jobs/jobs.service';
import { CONSENTS_JOBS } from './consents.constants';

type Tx = Prisma.TransactionClient;

/**
 * Журнал инцидентов безопасности ПДн (ЗоПД ст. 25 п. 2 пп. 8; Правила № 179/НҚ п. 11;
 * Правила № 481/НҚ): уполномоченный орган уведомляется в течение ОДНОГО РАБОЧЕГО ДНЯ с
 * момента обнаружения, затем — субъекты. Без инструмента срок не соблюсти: инцидент
 * открывается командой кабинета, дедлайн считается сразу, тревога уходит при открытии и
 * за `alertBeforeHours` до срока. Сами уведомления органа и субъектов делает человек —
 * журнал фиксирует факт и момент (append-only события).
 *
 * Лестница статуса строго вперёд: open → authority_notified → subjects_notified → closed
 * (закрыть можно из любого незакрытого — инцидент мог не затронуть субъектов).
 */
@Injectable()
export class ConsentsIncidentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsService,
  ) {}

  async open(tx: Tx, actorUserId: string, input: PdIncidentOpenInput): Promise<PdIncident> {
    const now = new Date();
    const detectedAt = input.detectedAt ? new Date(input.detectedAt) : now;
    if (Number.isNaN(detectedAt.getTime()) || detectedAt.getTime() > now.getTime() + 60_000) throw badRequest('pd.incident.detectedInFuture');
    const notifyDeadlineAt = addBusinessDays(detectedAt, PD_INCIDENT_LIMITS.notifyBusinessDays);
    const incident = await tx.pdIncident.create({
      data: { kind: input.kind, scope: input.scope, summary: input.summary, affectedEstimate: input.affectedEstimate ?? null, detectedAt, notifyDeadlineAt, actorUserId },
    });
    await tx.pdIncidentEvent.create({ data: { incidentId: incident.id, type: 'opened' satisfies PdIncidentEventType, actorUserId } });
    const alertAt = new Date(notifyDeadlineAt.getTime() - PD_INCIDENT_LIMITS.alertBeforeHours * 3_600_000);
    await this.jobs.enqueue(tx, {
      type: CONSENTS_JOBS.incidentDeadlineAlert,
      payload: { incidentId: incident.id },
      // Инцидент, открытый позже «дедлайн минус 4 часа», тревожит сразу
      runAt: alertAt.getTime() > now.getTime() ? alertAt : now,
      uniqueKey: `pd-incident-alert:${incident.id}`,
    });
    return incident;
  }

  private async step(tx: Tx, actorUserId: string, incidentId: string, from: PdIncidentStatus[], to: PdIncidentStatus, stamp: 'authorityNotifiedAt' | 'subjectsNotifiedAt' | 'closedAt', event: PdIncidentEventType, note: string | null): Promise<PdIncident> {
    const now = new Date();
    // Переход — status-guarded: повтор и гонка двух сотрудников не дают двойного штампа
    const { count } = await tx.pdIncident.updateMany({ where: { id: incidentId, status: { in: from } }, data: { status: to, [stamp]: now } });
    if (count === 0) {
      const exists = await tx.pdIncident.findUnique({ where: { id: incidentId }, select: { id: true } });
      throw exists ? conflict('pd.incident.wrongStatus') : notFound('pd.incident.notFound');
    }
    await tx.pdIncidentEvent.create({ data: { incidentId, type: event, note, actorUserId } });
    return tx.pdIncident.findUniqueOrThrow({ where: { id: incidentId } });
  }

  notifyAuthority(tx: Tx, actorUserId: string, incidentId: string, note: string | null) {
    return this.step(tx, actorUserId, incidentId, ['open'], 'authority_notified', 'authorityNotifiedAt', 'authority_notified', note);
  }

  notifySubjects(tx: Tx, actorUserId: string, incidentId: string, note: string | null) {
    return this.step(tx, actorUserId, incidentId, ['authority_notified'], 'subjects_notified', 'subjectsNotifiedAt', 'subjects_notified', note);
  }

  close(tx: Tx, actorUserId: string, incidentId: string, note: string | null) {
    return this.step(tx, actorUserId, incidentId, ['open', 'authority_notified', 'subjects_notified'], 'closed', 'closedAt', 'closed', note);
  }

  /**
   * Джоб «до дедлайна 4 часа»: тревога нужна, только пока орган не уведомлён. Клейм
   * (`deadlineAlertedAt`) ставится ПОСЛЕ отправки вызывающим через `markAlerted` — иначе
   * упавшая отправка оставила бы инцидент без тревоги.
   */
  async dueForAlert(incidentId: string): Promise<PdIncident | null> {
    const row = await this.db.pdIncident.findUnique({ where: { id: incidentId } });
    if (!row || row.status !== 'open' || row.deadlineAlertedAt) return null;
    return row;
  }

  async markAlerted(incidentId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.pdIncident.updateMany({ where: { id: incidentId, deadlineAlertedAt: null }, data: { deadlineAlertedAt: new Date() } });
      if (count > 0) await tx.pdIncidentEvent.create({ data: { incidentId, type: 'deadline_alert' satisfies PdIncidentEventType } });
    });
  }

  toDto(row: PdIncident & { events?: PdIncidentEvent[] }): PdIncidentDto {
    return {
      id: row.id,
      kind: row.kind as PdIncidentKind,
      status: row.status as PdIncidentStatus,
      scope: row.scope,
      summary: row.summary,
      affectedEstimate: row.affectedEstimate,
      detectedAt: row.detectedAt.toISOString(),
      notifyDeadlineAt: row.notifyDeadlineAt.toISOString(),
      authorityNotifiedAt: row.authorityNotifiedAt?.toISOString() ?? null,
      subjectsNotifiedAt: row.subjectsNotifiedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      overdue: row.status === 'open' && row.notifyDeadlineAt.getTime() < Date.now(),
      events: (row.events ?? []).map((e) => ({ id: e.id.toString(), type: e.type as PdIncidentEventType, note: e.note, actorUserId: e.actorUserId, occurredAt: e.occurredAt.toISOString() })),
    };
  }

  async list(): Promise<PdIncidentDto[]> {
    const rows = await this.db.pdIncident.findMany({ include: { events: { orderBy: { occurredAt: 'asc' } } }, orderBy: [{ detectedAt: 'desc' }], take: 200 });
    return rows.map((r) => this.toDto(r));
  }
}
