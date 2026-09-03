import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  approvalHref,
  APPROVAL_LIMITS,
  APPROVAL_STEP_KIND_LABELS,
  formatTaskDeadline,
  type ApprovalStepKind,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { ApprovalsRegistry } from './approvals.registry';
import { ApprovalsService } from './approvals.service';
import { AudiencesService } from '../audiences/audiences.service';
import {
  APPROVAL_ANNOUNCE_JOB,
  APPROVAL_ESCALATE_JOB,
  APPROVAL_REMIND_JOB,
  APPROVAL_RESOLVED_JOB,
} from './approvals.job-names';

// Имена джобов живут отдельным файлом без импортов: этот модуль инжектит
// ApprovalsService, а тот ставит джобы — общий файл-константы разрывает кольцо.
export {
  APPROVAL_ANNOUNCE_JOB,
  APPROVAL_ESCALATE_JOB,
  APPROVAL_REMIND_JOB,
  APPROVAL_RESOLVED_JOB,
} from './approvals.job-names';

/**
 * Фоновая часть движка согласований. Оба типа — обязательная работа, поэтому
 * core/jobs, а не шина: событие at-most-once потеряло бы побудку процесса, и
 * маршрут завис бы навсегда после уже принятого решения.
 */
@Injectable()
export class ApprovalsJobs implements OnModuleInit {
  private readonly logger = new Logger(ApprovalsJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRegistry,
    private readonly registry: ApprovalsRegistry,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly audiences: AudiencesService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(APPROVAL_REMIND_JOB, (p) => this.remind(String(p.stepId)), { queue: 'default' });
    this.jobs.register(APPROVAL_ESCALATE_JOB, (p) => this.escalate(String(p.stepId)), { queue: 'default' });
    this.jobs.register(APPROVAL_RESOLVED_JOB, (p) => this.resolved(String(p.requestId)), { queue: 'default' });
    this.jobs.register(APPROVAL_ANNOUNCE_JOB, (p) => this.announce(String(p.requestId)), { queue: 'default' });
  }

  /** Оповещение о состоянии заявки, отложенное до коммита (см. APPROVAL_ANNOUNCE_JOB) */
  private async announce(requestId: string): Promise<void> {
    await this.approvals.announcePublic(requestId);
  }

  /**
   * Напоминание ДО срока — только тем, кто ещё не ответил, и только им: автору
   * тревожиться нечем, пока срок не вышел (у него это уже эскалация).
   *
   * Своей колонки-дедупа здесь нет намеренно: at-least-once закрывает `dedupKey`
   * уведомления, и второй заход джоба не породит второй строки в ленте. Колонка
   * ради этого была бы третьим состоянием шага, которое надо не забыть сбросить
   * при переносе срока.
   */
  private async remind(stepId: string): Promise<void> {
    const step = await this.db.approvalStep.findUnique({
      where: { id: stepId },
      include: { request: true, decisions: { select: { userId: true } } },
    });
    if (!step || step.status !== 'active' || step.request.status !== 'pending') return;
    if (!step.deadlineAt) return;
    // Срок уже вышел — напоминать поздно, это работа эскалации. Срок перенесли
    // вперёд — этот джоб от старого срока, у нового будет свой (ключ с версией).
    const left = step.deadlineAt.getTime() - Date.now();
    if (left <= 0 || left > APPROVAL_LIMITS.remindBeforeMs) return;

    const answered = new Set(step.decisions.map((d) => d.userId));
    const waiting = step.awaitingUserIds.filter((uid) => !answered.has(uid));
    if (waiting.length === 0) return;

    const payload = {
      refTitle: step.request.refTitle,
      stepTitle: step.title,
      // Время в APP_TIMEZONE, а не в поясе сервера: «до 05.08 18:00» должно
      // значить одно и то же и в проде на UTC, и на машине разработчика.
      deadlineLabel: formatTaskDeadline(step.deadlineAt, false),
    };
    const actionUrl = this.hrefFor(step.request.workspaceId, step.requestId);

    for (const uid of waiting) {
      await this.notifications
        .notify(uid, 'approval.due_soon', payload, { actionUrl, dedupKey: `aprm:${stepId}:${uid}` })
        .catch(() => undefined);
    }
  }

  /** Рабочая заявка адресуется внутрь организации — см. `approvalHref` в shared */
  private hrefFor(workspaceId: string | null, requestId: string): string {
    return approvalHref(requestId, workspaceId);
  }

  /**
   * Эскалация просрочки. Идемпотентна: повторный заход видит `escalatedAt` и молчит.
   * Система НЕ решает за человека — «молчание = согласие» отвергнуто осознанно:
   * подпись под документом от того, кто его не открывал, ничего не стоит.
   */
  private async escalate(stepId: string): Promise<void> {
    const step = await this.db.approvalStep.findUnique({
      where: { id: stepId },
      include: { request: true },
    });
    // Шага нет / решён / заявка закрыта / срок перенесли — работа потеряла смысл.
    // Это НЕ ошибка: тихо выходим, иначе движок жёг бы попытки и хоронил джоб
    // с ложным инцидентом.
    if (!step || step.status !== 'active' || step.request.status !== 'pending') return;
    if (step.escalatedAt) return;
    if (!step.deadlineAt || step.deadlineAt.getTime() > Date.now()) return;

    const marked = await this.db.approvalStep.updateMany({
      where: { id: stepId, escalatedAt: null, status: 'active' },
      data: { escalatedAt: new Date() },
    });
    if (marked.count === 0) return; // соседний инстанс успел первым

    const labels = APPROVAL_STEP_KIND_LABELS[step.kind as ApprovalStepKind];
    const actionUrl = this.hrefFor(step.request.workspaceId, step.requestId);

    const payload = { refTitle: step.request.refTitle, stepTitle: step.title, actionLabel: labels.action };
    // Автор узнаёт вместе с адресатами: просрочка — это его проблема, а не их.
    // И ВВЕРХ: руководитель каждого просрочившего (оргструктура; вершина → владелец) —
    // эскалация идёт по вертикали, а не только «по кругу». Провал разворота не роняет
    // эскалацию адресатам.
    const managers = step.request.workspaceId
      ? await this.audiences
          .resolve(
            step.awaitingUserIds.map((uid) => ({ type: 'manager_of' as const, id: uid })),
            { workspaceId: step.request.workspaceId },
            { max: 200, onOverflow: 'truncate' },
          )
          .catch((e) => {
            this.logger.warn(`эскалация ${stepId}: руководители не развернулись — ${(e as Error).message}`);
            return [] as string[];
          })
      : [];
    const recipients = [...new Set([...step.awaitingUserIds, step.request.createdById, ...managers])];
    for (const uid of recipients) {
      await this.notifications
        .notify(uid, 'approval.overdue', payload, { actionUrl, dedupKey: `apov:${stepId}:${uid}` })
        .catch(() => undefined);
    }
  }

  /**
   * Заявка закрыта — вернуть управление тому, кто её вёл. Хук идемпотентен со
   * стороны потребителя (движок Процессов перечитывает шаг под своим локом), что и
   * требуется при at-least-once.
   */
  private async resolved(requestId: string): Promise<void> {
    const request = await this.db.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request || !request.originType || !request.originRef) return;
    if (request.status === 'pending') return;

    // Отзыв автором — тоже итог, и ведущий обязан его получить: иначе шаг маршрута
    // ждёт решения, которого уже никто не вынесет. Для маршрута это «на доработку»:
    // предмет возвращается автору, а не объявляется отклонённым кем-то из людей.
    const outcome = request.status === 'cancelled' ? 'returned' : (request.status as 'approved' | 'rejected' | 'returned');

    const origin = this.registry.getOrigin(request.originType);
    if (!origin) {
      // Ретраи не помогут: провайдер регистрируется на старте модуля, и если его
      // нет сейчас — не будет и через час. Хороним сразу (движок логирует это
      // предупреждением, а не инцидентом), но громко: это дефект сборки.
      throw new JobDiscardError(`нет провайдера origin "${request.originType}" — заявка ${requestId} осталась без побудки`);
    }

    await origin.onResolved(request.originRef, outcome);
  }
}
