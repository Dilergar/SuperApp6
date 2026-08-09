import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SIGN_LEVEL_LABELS, signRequestHref, type SignLevel } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { SignRegistry } from './sign.registry';

/** Позвать подписантов — ставится при создании заявки */
export const SIGN_REQUESTED_JOB = 'sign.requested';
/** Акт закрылся: сообщить потребителю и людям — ставится В ТРАНЗАКЦИИ закрытия */
export const SIGN_FINISHED_JOB = 'sign.act.finished';

/**
 * Фон движка подписи. Ровно две обязательные работы, и обе поставлены
 * transactional outbox'ом (джоб уезжает тем же коммитом, что и сама подпись):
 *
 *  • позвать подписантов — иначе человек просто не узнает, что его ждут;
 *  • разбудить потребителя и сообщить итог — «документ подписан» должно
 *    случиться, даже если в этот момент упал инстанс.
 *
 * На шину это класть нельзя: она at-most-once, а «на шину — только то, что
 * можно потерять» (правило платформы).
 */
@Injectable()
export class SignJobs implements OnModuleInit {
  private readonly logger = new Logger(SignJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRegistry,
    private readonly registry: SignRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(SIGN_REQUESTED_JOB, (p) => this.announce(String(p.requestId)), { queue: 'sign' });
    this.jobs.register(
      SIGN_FINISHED_JOB,
      (p) =>
        this.finished({
          actId: String(p.actId),
          outcome: p.outcome === 'declined' ? 'declined' : 'signed',
          reason: typeof p.reason === 'string' ? p.reason : null,
        }),
      { queue: 'sign' },
    );
  }

  /** «Подпишите документ» — каждому, кого ждут */
  private async announce(requestId: string): Promise<void> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: true },
    });
    // Заявка исчезла — работа потеряла смысл. Это ПОСТОЯННАЯ ошибка: ретраить
    // нечего, и ложный dead-letter здесь был бы инцидентом на пустом месте.
    if (!request) throw new JobDiscardError('заявка на подпись удалена');
    if (request.status !== 'pending') return;

    const href = signRequestHref(request.id, request.workspaceId);
    for (const act of request.acts) {
      if (act.status !== 'pending' || !act.signerUserId) continue;
      await this.notifications
        .notify(
          act.signerUserId,
          'sign.requested',
          {
            refTitle: request.refTitle,
            levelLabel: SIGN_LEVEL_LABELS[request.level as SignLevel].short,
          },
          { actionUrl: href, dedupKey: `sign:req:${act.id}` },
        )
        .catch(() => undefined);
    }
  }

  /**
   * Акт закрылся: хук потребителя + уведомление автору заявки.
   *
   * Хук потребителя идёт ПЕРВЫМ и его ошибка поднимается наверх (движок
   * ретраит): отметка «документ подписан» на карточке — обязательная работа.
   * Уведомления — best-effort: упавшая лента не имеет права заставить
   * переигрывать подпись.
   */
  private async finished(payload: FinishedPayload): Promise<void> {
    const act = await this.db.signAct.findUnique({
      where: { id: payload.actId },
      include: { request: { include: { acts: { select: { status: true, signerName: true } } } } },
    });
    if (!act) throw new JobDiscardError('акт подписи удалён');
    const request = act.request;

    const provider = this.registry.get(request.refType);
    if (provider?.onActFinished) {
      await provider.onActFinished(request.refId, {
        requestId: request.id,
        actId: act.id,
        outcome: payload.outcome,
        level: act.level as 'ecp' | 'pep',
        signerUserId: act.signerUserId,
        requestCompleted: request.status === 'completed',
      });
    }

    const href = signRequestHref(request.id, request.workspaceId);
    if (payload.outcome === 'declined') {
      await this.notifications
        .notify(
          request.createdById,
          'sign.declined',
          { refTitle: request.refTitle, reason: payload.reason ?? '' },
          { actionUrl: href, dedupKey: `sign:dec:${act.id}` },
        )
        .catch(() => undefined);
      return;
    }

    // «Подписано» автору говорим ОДИН раз — когда закрылась вся заявка, а не на
    // каждой подписи: у документа с тремя подписантами иначе три уведомления.
    if (request.status !== 'completed') return;
    const names = request.acts
      .filter((a) => a.status === 'signed')
      .map((a) => a.signerName)
      .join(', ');
    await this.notifications
      .notify(
        request.createdById,
        'sign.completed',
        { refTitle: request.refTitle, signersLabel: names },
        { actionUrl: href, dedupKey: `sign:done:${request.id}` },
      )
      .catch(() => undefined);
  }
}

interface FinishedPayload {
  actId: string;
  outcome: 'signed' | 'declined';
  reason: string | null;
}
