import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  approvalHref,
  APPROVAL_ERROR_CODES,
  APPROVAL_KIND_DECISIONS,
  APPROVAL_LIMITS,
  APPROVAL_DECISIONS_NEEDING_COMMENT,
  APPROVAL_REQUEST_STATUS_LABELS,
  APPROVAL_STEP_KIND_LABELS,
  SIGN_APPROVAL_NEEDS_SIGNATURE,
  INBOX_SOURCE_KEYS,
  TEAM_WORKSPACE_ROLES,
  type ApprovalActorLite,
  type ApprovalDecisionKind,
  type ApprovalInboxScope,
  type ApprovalMinePage,
  type ApprovalRequestDto,
  type ApprovalSignatureKind,
  type ApprovalSignatureRequirement,
  type ApprovalStepDto,
  type ApprovalStepKind,
  type CreateApprovalInput,
  type InboxItemDto,
  type InboxScope,
  type InboxPageDto,
  type InboxCountDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { AccessService } from '../access/access.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { ApprovalsRegistry, type ApprovalRefContext } from './approvals.registry';
import {
  APPROVAL_ANNOUNCE_JOB,
  APPROVAL_ESCALATE_JOB,
  APPROVAL_REMIND_JOB,
  APPROVAL_RESOLVED_JOB,
} from './approvals.job-names';

type Tx = Prisma.TransactionClient;

/** Контекст роли в организации (роли живут в UserRole — единый источник) */
const WS_CONTEXT = 'workspace';

/** Ошибка движка с машинным кодом в `details.code` — клиент ветвится по нему, не по тексту */
function coded(message: string, code: string): BadRequestException {
  return new BadRequestException({ message, details: { code } });
}

/**
 * core/approvals — 14-й платформенный движок: «Задачник для решений».
 *
 * Заявка = ПРЕДМЕТ + прямой список шагов. Шаги с одинаковым `order` идут
 * одновременно, следующая группа активируется, когда закрылась предыдущая.
 * Ветвлений, условий и циклов здесь НЕТ — это движок Процессов, и второй такой
 * писать нельзя.
 *
 * Кто ведёт заявку снаружи (процесс) — для движка непрозрачная пара
 * `originType`+`originRef`: по типу он находит хук в реестре и отдаёт ссылку как
 * есть. Так направление знания остаётся «потребитель → движок».
 */
@Injectable()
export class ApprovalsService implements OnModuleInit {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ApprovalsRegistry,
    private readonly access: AccessService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Движок регистрирует СЕБЯ первым источником стопки. Дальше рядом встанут очереди
   * задач отдела из Процессов и приёмка работы из Задачника — каждая своей
   * регистрацией, и ни модалку, ни счётчик трогать не придётся.
   */
  onModuleInit(): void {
    this.registry.registerSource(INBOX_SOURCE_KEYS.approval, {
      label: 'Согласования',
      count: (userId, scope) => this.countPending(userId, scope),
      list: (userId, limit, scope) => this.listPending(userId, limit, scope),
    });
  }

  // ============================================================
  // Создание
  // ============================================================

  /**
   * Завести заявку. Зовёт ПОТРЕБИТЕЛЬ, уже проверив своё право «отправить это на
   * согласование»: движок не знает, что такое право для документа, счёта и задачи,
   * и не должен угадывать. Его дело — резолвер, маршрут и решения.
   */
  async create(
    userId: string,
    dto: CreateApprovalInput,
    origin?: { type: string; ref: string },
  ): Promise<ApprovalRequestDto> {
    const provider = this.registry.get(dto.refType);
    if (!provider) throw new NotFoundException(`Тип «${dto.refType}» не зарегистрирован в согласованиях`);

    const ctx = await provider.describeForCreate(userId, dto.refId);
    if (!ctx) throw new NotFoundException('Объект не найден');

    // Группы очерёдности нормализуем в 0,1,2…: автор маршрута мог расставить 10/20/30,
    // и «следующая группа» должна находиться по порядку, а не по арифметике его чисел.
    const orders = [...new Set(dto.steps.map((s) => s.order))].sort((a, b) => a - b);
    const normalized = dto.steps.map((s) => ({ ...s, order: orders.indexOf(s.order) }));

    // Ведущий зовёт нас ПОВТОРНО — это норма, а не сбой: у движка Процессов
    // исполнение шагов at-least-once, и толчок мог повториться после того, как
    // заявка уже создалась. Повтор обязан вернуть ТУ ЖЕ заявку: иначе у одного
    // шага маршрута оказалось бы два согласования, и человек получил бы один
    // документ дважды. Быстрый путь — до транзакции, гонку добирает уникальный
    // индекс ниже (проверка в приложении её принципиально не закрывает).
    if (origin) {
      const twin = await this.findByOrigin(origin);
      if (twin) return this.get(userId, twin);
    }

    let requestId: string;
    try {
      requestId = await this.createTx(userId, dto, normalized, ctx, origin);
    } catch (err) {
      if (origin && (err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
        const twin = await this.findByOrigin(origin);
        if (twin) return this.get(userId, twin);
      }
      throw err;
    }

    // Позвать адресатов ПЕРВОЙ группы. Только после коммита: уведомление не имеет
    // права ни уронить создание заявки, ни уйти по откатившейся транзакции.
    await this.announce(requestId).catch((err) =>
      this.logger.error(`оповещение по заявке ${requestId}: ${(err as Error).message}`),
    );

    return this.get(userId, requestId);
  }

  /** Живая заявка того же ведущего (тот же шаг маршрута) — или null */
  private async findByOrigin(origin: { type: string; ref: string }): Promise<string | null> {
    const row = await this.db.approvalRequest.findFirst({
      where: { originType: origin.type, originRef: origin.ref, status: 'pending' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private async createTx(
    userId: string,
    dto: CreateApprovalInput,
    normalized: CreateApprovalInput['steps'],
    ctx: ApprovalRefContext,
    origin?: { type: string; ref: string },
  ): Promise<string> {
    return this.db.$transaction(async (tx) => {
      const request = await tx.approvalRequest.create({
        data: {
          refType: dto.refType,
          refId: dto.refId,
          refTitle: ctx.title.slice(0, APPROVAL_LIMITS.maxTitleLength),
          refIcon: ctx.icon ?? null,
          workspaceId: ctx.workspaceId,
          createdById: userId,
          originType: origin?.type ?? null,
          originRef: origin?.ref ?? null,
        },
        select: { id: true },
      });

      for (const step of normalized) {
        await tx.approvalStep.create({
          data: {
            requestId: request.id,
            order: step.order,
            kind: step.kind,
            title: step.title ?? APPROVAL_STEP_KIND_LABELS[step.kind].action,
            assigneeType: step.assigneeType,
            assigneeId: step.assigneeId,
            assigneeLabel: await this.labelOf(tx, step.assigneeType, step.assigneeId),
            rule: step.rule ?? 'any',
            dueHours: step.dueInHours ?? null,
            // Требование подписи пишем ВМЕСТЕ со строкой шага, до его активации:
            // проставленное отдельным вызовом после создания, оно оставляло окно, в
            // котором адресаты уже позваны, а шаг ещё закрывается обычным кликом.
            requiredSignatureKind: step.requiredSignatureKind ?? null,
          },
        });
      }

      await this.activateGroup(tx, request.id, 0, ctx.workspaceId);
      return request.id;
    });
  }

  /**
   * Активировать группу шагов: снять СНИМОК адресатов, поставить сроки и джобы
   * напоминания и эскалации. Всё в транзакции вызывающего — иначе «шаг активен,
   * но никого не уведомили» пережило бы откат.
   */
  private async activateGroup(
    tx: Tx,
    requestId: string,
    order: number,
    workspaceId: string | null,
  ): Promise<{ activated: number }> {
    const steps = await tx.approvalStep.findMany({
      where: { requestId, order, status: 'waiting' },
      select: { id: true, title: true, assigneeType: true, assigneeId: true, dueHours: true },
    });
    if (steps.length === 0) return { activated: 0 };

    const now = new Date();

    for (const step of steps) {
      const awaiting = await this.resolveAssignees(tx, step.assigneeType, step.assigneeId, workspaceId);
      // Пустой снимок — ЧЕСТНАЯ ОШИБКА, а не молчаливая активация: шаг, который
      // никого не ждёт, висит вечно (битый id адресата, чужой справочник, пустой
      // отдел). Создателю заявки отказ приходит сразу; решающему предыдущего
      // шага — понятным текстом (его решение откатывается вместе с транзакцией,
      // и маршрут остаётся согласованным).
      if (awaiting.length === 0) {
        throw coded(
          `Шаг «${step.title}» никому не адресован: адресат пуст или не существует — исправьте маршрут`,
          APPROVAL_ERROR_CODES.emptyAssignees,
        );
      }
      const deadlineAt = step.dueHours ? new Date(now.getTime() + step.dueHours * 3_600_000) : null;

      await tx.approvalStep.updateMany({
        where: { id: step.id, status: 'waiting' },
        data: { status: 'active', activatedAt: now, awaitingUserIds: awaiting, deadlineAt },
      });

      if (deadlineAt) {
        await this.jobs.enqueue(tx, {
          type: APPROVAL_ESCALATE_JOB,
          payload: { stepId: step.id },
          runAt: deadlineAt,
          // Ключ с версией срока: перенос дедлайна = новый джоб, старый отработает
          // вхолостую и увидит, что срок другой (приём отложенных сообщений).
          uniqueKey: `apst:${step.id}:${deadlineAt.getTime()}`,
        });

        // Напоминание ДО срока. Просрочка — уже потеря: к ней приходят с вопросом
        // «почему», а не с документом. Считаем от МЕНЬШЕГО из суток и половины
        // окна, чтобы у короткого шага напоминание не оказалось раньше самой
        // заявки; на совсем узком окне не напоминаем вовсе (два уведомления
        // подряд об одном и том же — это шум, а не забота).
        const remindAt = this.remindMoment(now, deadlineAt);
        if (remindAt) {
          await this.jobs.enqueue(tx, {
            type: APPROVAL_REMIND_JOB,
            payload: { stepId: step.id },
            runAt: remindAt,
            uniqueKey: `aprm:${step.id}:${deadlineAt.getTime()}`,
          });
        }
      }
    }

    return { activated: steps.length };
  }

  /** Когда напомнить о сроке — или null, если окно слишком короткое */
  private remindMoment(now: Date, deadlineAt: Date): Date | null {
    const window = deadlineAt.getTime() - now.getTime();
    if (window <= APPROVAL_LIMITS.remindMinWindowMs) return null;
    const before = Math.min(APPROVAL_LIMITS.remindBeforeMs, Math.floor(window / 2));
    return new Date(deadlineAt.getTime() - before);
  }

  /**
   * Снять уволенного с АКТИВНЫХ шагов организации — ОБЩИЙ метод для обоих
   * каскадов увольнения (`removeMember` И `leaveWorkspace`: они продублированы,
   * и правило, живущее в одном из них, — не правило).
   *
   * До него каскады approval_steps не трогали, а решать уволенному запрещал
   * гейт — шаг `rule:'all'` виснул навсегда, и закрыть его можно было только
   * отменой всей заявки. Снятие ПЕРЕСЧИТЫВАЕТ закрытие шага: остальные могли
   * уже решить — тогда шаг закрывается и активируется следующая группа.
   * Опустевший шаг (снятый был единственным) закрывается как `skipped` с
   * уведомлением автору: молчаливое вечное зависание хуже видимого пропуска.
   */
  async releaseUserFromWorkspaceSteps(userId: string, workspaceId: string): Promise<void> {
    const steps = await this.db.approvalStep.findMany({
      where: {
        status: 'active',
        awaitingUserIds: { has: userId },
        request: { workspaceId, status: 'pending' },
      },
      select: { id: true },
    });

    for (const { id } of steps) {
      try {
        await this.db.$transaction(async (tx) => {
          // Замок сериализует пересчёт с параллельными решениями (тот же приём,
          // что в applyDecision у правила «каждый»).
          await tx.$queryRaw`SELECT id FROM approval_steps WHERE id = ${id} FOR UPDATE`;
          const step = await tx.approvalStep.findUnique({
            where: { id },
            include: { request: { select: { workspaceId: true, status: true, createdById: true, refTitle: true } } },
          });
          if (!step || step.status !== 'active' || step.request.status !== 'pending') return;
          if (!step.awaitingUserIds.includes(userId)) return;

          const remaining = step.awaitingUserIds.filter((u) => u !== userId);
          await tx.approvalStep.update({ where: { id }, data: { awaitingUserIds: remaining } });

          // «Любой из» с живыми адресатами — шаг просто ждёт остальных.
          if (step.rule === 'any' && remaining.length > 0) return;

          let closeAs: 'approved' | 'skipped' | null = null;
          if (remaining.length === 0) {
            const approvals = await tx.approvalDecision.count({
              where: { stepId: id, decision: 'approved' },
            });
            closeAs = approvals > 0 ? 'approved' : 'skipped';
          } else if (step.rule === 'all') {
            const approvals = await tx.approvalDecision.count({
              where: { stepId: id, decision: 'approved', userId: { in: remaining } },
            });
            if (approvals >= remaining.length) closeAs = 'approved';
          }
          if (!closeAs) return;

          const won = await tx.approvalStep.updateMany({
            where: { id, status: 'active' },
            data: { status: closeAs, decidedAt: new Date() },
          });
          if (won.count === 0) return;

          if (closeAs === 'skipped') {
            await this.notifications
              .notify(
                step.request.createdById,
                'approval.unassigned',
                { refTitle: step.request.refTitle, stepTitle: step.title, assigneeLabel: step.assigneeLabel ?? 'адресату' },
                { actionUrl: this.hrefFor(step.request.workspaceId, step.requestId), dedupKey: `apun:${id}` },
              )
              .catch(() => undefined);
          }

          const groupOpen = await tx.approvalStep.count({
            where: { requestId: step.requestId, order: step.order, status: 'active' },
          });
          if (groupOpen > 0) return;

          const next = await tx.approvalStep.findFirst({
            where: { requestId: step.requestId, status: 'waiting' },
            orderBy: { order: 'asc' },
            select: { order: true },
          });
          if (!next) {
            await this.closeRequest(tx, step.requestId, 'approved', null);
            return;
          }
          await this.activateGroup(tx, step.requestId, next.order, step.request.workspaceId);
        });
      } catch (e) {
        // Ошибка одного шага (например, следующая группа разворачивается в никого)
        // не должна остановить каскад увольнения: транзакция шага откатилась,
        // остальное продолжаем. Заявку в тупике закроют отменой.
        this.logger.warn(`releaseUserFromWorkspaceSteps: шаг ${id} — ${(e as Error).message}`);
      }
    }

    // Стопка — витрина ПО РЕЕСТРУ источников, и правило «обязанность решать не
    // переживает членство» обязано действовать во всех, а не только в заявках
    // этого движка: кампания ознакомления КЭДО держала уволенного адресатом
    // навсегда. Хук необязателен — источники без него просто пропускаются.
    for (const [key, source] of this.registry.sourceEntries()) {
      if (!source.releaseUser) continue;
      await source
        .releaseUser(userId, workspaceId)
        .catch((e) => this.logger.warn(`releaseUser источника ${key}: ${(e as Error).message}`));
    }
  }

  /**
   * Развернуть адресата в поимённый список. Делается РОВНО ОДИН РАЗ, при активации.
   *
   * Снимок, а не живой запрос, по двум причинам: принятый в середине согласования
   * сотрудник не должен молча получать чужую обязанность, а уволенный — навсегда
   * подвешивать шаг «нужен каждый», который уже некому закрыть. Побочная выгода:
   * читающий путь стопки не ходит в движок прав вообще — одно условие по массиву.
   */
  private async resolveAssignees(
    tx: Tx,
    assigneeType: string,
    assigneeId: string,
    workspaceId: string | null,
  ): Promise<string[]> {
    // Предмет живёт в организации — значит и адресат обязан быть ЕЁ. Без этой сверки
    // достаточно подставить в маршрут uuid отдела чужой компании, и её сотрудники
    // получают в стопку шаг с названием и номером чужого документа.
    if (workspaceId && assigneeType !== 'user' && !(await this.belongsToWorkspace(tx, assigneeType, assigneeId, workspaceId))) {
      return [];
    }

    if (assigneeType === 'user') {
      if (workspaceId && !(await this.isTeamMember(tx, assigneeId, workspaceId))) return [];
      return [assigneeId];
    }

    const rows = await tx.relationTuple.findMany({
      where: {
        resourceType: assigneeType,
        resourceId: assigneeId,
        relation: assigneeType === 'position' ? 'holder' : 'member',
        subjectType: 'user',
        subjectRelation: '',
      },
      select: { subjectId: true },
      // +1 сверх потолка: превышение — ЧЕСТНЫЙ ОТКАЗ с числом, а не молчаливая
      // обрезка. Обрезанный снимок на компании в 600 человек означал бы 100
      // неознакомленных, о которых никто не узнает.
      take: APPROVAL_LIMITS.maxSnapshotSize + 1,
    });
    const ids = [...new Set(rows.map((r) => r.subjectId))];
    if (ids.length > APPROVAL_LIMITS.maxSnapshotSize) {
      throw coded(
        `Адресатов больше потолка (${APPROVAL_LIMITS.maxSnapshotSize}): у шага «каждый» состав фиксируется поимённо. Для массовых ознакомлений используйте кампании КЭДО`,
        APPROVAL_ERROR_CODES.snapshotTooBig,
      );
    }
    if (!workspaceId || ids.length === 0) return ids;
    // Проекция оси может отставать от увольнения — команду перепроверяем поимённо
    // одним запросом (обязанность решать не должна переживать выход из организации).
    const live = await tx.userRole.findMany({
      where: {
        userId: { in: ids },
        context: WS_CONTEXT,
        tenantId: workspaceId,
        isActive: true,
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
      select: { userId: true },
    });
    const alive = new Set(live.map((r) => r.userId));
    return ids.filter((id) => alive.has(id));
  }

  /** Ось оргструктуры принадлежит этой организации? */
  private async belongsToWorkspace(
    tx: Tx,
    assigneeType: string,
    assigneeId: string,
    workspaceId: string,
  ): Promise<boolean> {
    if (assigneeType === 'position') {
      return (await tx.staffPosition.count({ where: { id: assigneeId, workspaceId } })) > 0;
    }
    if (assigneeType === 'department') {
      return (await tx.staffDepartment.count({ where: { id: assigneeId, workspaceId } })) > 0;
    }
    if (assigneeType === 'branch') {
      return (await tx.staffBranch.count({ where: { id: assigneeId, workspaceId } })) > 0;
    }
    return false;
  }

  /** Действующий член команды организации (Подрядчик — не команда) */
  private async isTeamMember(tx: Tx | DatabaseService, userId: string, workspaceId: string): Promise<boolean> {
    const count = await tx.userRole.count({
      where: {
        userId,
        context: WS_CONTEXT,
        tenantId: workspaceId,
        isActive: true,
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
    });
    return count > 0;
  }

  /** Название должности/отдела — снимком, чтобы история решений пережила переименование */
  private async labelOf(tx: Tx, assigneeType: string, assigneeId: string): Promise<string | null> {
    if (assigneeType === 'position') {
      const row = await tx.staffPosition.findUnique({ where: { id: assigneeId }, select: { name: true } });
      return row?.name ?? null;
    }
    if (assigneeType === 'department') {
      const row = await tx.staffDepartment.findUnique({ where: { id: assigneeId }, select: { name: true } });
      return row?.name ?? null;
    }
    if (assigneeType === 'branch') {
      const row = await tx.staffBranch.findUnique({ where: { id: assigneeId }, select: { name: true } });
      return row?.name ?? null;
    }
    return null;
  }

  // ============================================================
  // Решение
  // ============================================================

  async decide(
    userId: string,
    stepId: string,
    dto: { decision: ApprovalDecisionKind; comment?: string },
    ip?: string | null,
  ): Promise<ApprovalRequestDto> {
    const step = await this.db.approvalStep.findUnique({
      where: { id: stepId },
      include: { request: true },
    });
    if (!step) throw new NotFoundException('Шаг не найден');
    if (step.request.status !== 'pending' || step.status !== 'active') {
      throw coded('Решение по этому шагу уже не требуется', APPROVAL_ERROR_CODES.stepNotActive);
    }

    // Адресность решает СНИМОК, а не текущее членство: он и есть зафиксированный
    // список тех, кого спросили.
    if (!step.awaitingUserIds.includes(userId)) {
      throw new ForbiddenException({
        message: 'Решение выносит адресат шага',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }

    // Снимок фиксируется при активации и про увольнение ничего не знает: без этой
    // сверки человек, уволенный в тот же день, открывал уведомление и подписывал
    // приказ бывшего работодателя — документ, который через сервис уже не откроет.
    if (step.request.workspaceId && !(await this.isTeamMember(this.db, userId, step.request.workspaceId))) {
      throw new ForbiddenException({
        message: 'Вы больше не работаете в этой организации',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }

    const allowed = APPROVAL_KIND_DECISIONS[step.kind as ApprovalStepKind] ?? [];
    if (!allowed.includes(dto.decision)) {
      throw coded(
        `На шаге «${APPROVAL_STEP_KIND_LABELS[step.kind as ApprovalStepKind].waiting}» такой исход недоступен`,
        APPROVAL_ERROR_CODES.decisionNotAllowed,
      );
    }

    const comment = dto.comment?.trim() || null;
    if (APPROVAL_DECISIONS_NEEDING_COMMENT.includes(dto.decision) && !comment) {
      throw coded('Укажите причину', APPROVAL_ERROR_CODES.commentRequired);
    }

    // Шаг требует НАСТОЯЩЕЙ подписи — обычный клик его не закрывает никогда.
    // Проверка стоит ЗДЕСЬ, а не в интерфейсе: кнопку можно не нажимать, а
    // HTTP-запрос отправить, и тогда приказ оказался бы «подписан» нажатием.
    if (step.requiredSignatureKind) {
      throw coded(
        'Этот шаг закрывается электронной подписью, а не нажатием кнопки',
        SIGN_APPROVAL_NEEDS_SIGNATURE,
      );
    }

    // Отпечаток предмета берём У ПОТРЕБИТЕЛЯ и пишем в решение: без него подпись
    // ничего не доказывает — файл могли переписать сразу после согласования.
    let subjectSha256: string | null = null;
    try {
      const ctx = await this.registry.get(step.request.refType)?.describeForCreate(userId, step.request.refId);
      subjectSha256 = ctx?.contentSha256 ?? null;
    } catch {
      subjectSha256 = null;
    }

    await this.db.$transaction((tx) =>
      this.applyDecision(tx, step, userId, {
        decision: dto.decision,
        comment,
        subjectSha256,
        // Публичный путь ВСЕГДА пишет `internal`. Уровень подписи от клиента не
        // принимается принципиально: иначе «подписано ЭЦП» становилось бы полем
        // в теле запроса.
        signatureKind: 'internal',
        ip,
      }),
    );

    await this.announce(step.requestId).catch((err) =>
      this.logger.error(`оповещение по заявке ${step.requestId}: ${(err as Error).message}`),
    );

    // Решение записано — потребителю, для которого оно юридический факт
    // (ознакомление с приказом → личный архив работника), сообщаем ПОСЛЕ
    // коммита и best-effort: упавший хук не отменяет состоявшееся решение.
    await this.registry
      .get(step.request.refType)
      ?.onDecided?.({
        refId: step.request.refId,
        stepKind: step.kind as ApprovalStepKind,
        decision: dto.decision as 'approved' | 'rejected' | 'returned',
        userId,
      })
      .catch((err) => this.logger.warn(`onDecided ${step.request.refType}: ${(err as Error).message}`));

    return this.get(userId, step.requestId);
  }

  /**
   * ЗАКРЫВАЮЩИЙ ВХОД для core/sign — «решение, подтверждённое подписью».
   *
   * Наружу не выставлен и зовётся ТОЛЬКО движком подписи изнутри транзакции
   * финализации акта: акт подписан и шаг закрыт одним коммитом, поэтому окна
   * «подписано, но шаг висит» не существует. Все инварианты обычного пути —
   * уникальный индекс «одно решение на шаг», статус-гвард, `FOR UPDATE` для
   * правила «нужен каждый», активация следующей группы — те же самые: тело
   * транзакции у обоих входов ОДНО (`applyDecision`), и разойтись им негде.
   *
   * Проверки адресности и вида шага здесь не дублируются: их уже сделал движок
   * подписи, когда заводил заявку под этот шаг, — но требование уровня
   * сверяется (ЭЦП закрывает шаг, которому хватает ПЭП, обратное — нет).
   */
  async decideAttested(
    tx: Tx,
    stepId: string,
    userId: string,
    input: {
      decision: ApprovalDecisionKind;
      signatureKind: Exclude<ApprovalSignatureKind, 'internal'>;
      subjectSha256: string;
      signActId: string;
      comment?: string | null;
    },
  ): Promise<void> {
    const step = await tx.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
    if (!step) throw new NotFoundException('Шаг не найден');
    if (step.request.status !== 'pending' || step.status !== 'active') {
      throw coded('Решение по этому шагу уже не требуется', APPROVAL_ERROR_CODES.stepNotActive);
    }
    if (!step.awaitingUserIds.includes(userId)) {
      throw new ForbiddenException({
        message: 'Решение выносит адресат шага',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }
    // Та же сверка, что и на обычном пути решения, и по той же причине: снимок
    // адресатов про увольнение ничего не знает. Проверить членство ОДИН РАЗ при
    // открытии экрана подписания (stepForSignature) недостаточно — заявка на
    // подпись живёт до 30 суток, и уволенный за это время сотрудник закрывал бы
    // шаг бывшего работодателя своей подписью, обратившись к ручкам акта напрямую.
    if (step.request.workspaceId && !(await this.isTeamMember(tx, userId, step.request.workspaceId))) {
      throw new ForbiddenException({
        message: 'Вы больше не работаете в этой организации',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }
    // Исход должен быть допустим для ВИДА шага — инвариант общий с обычным путём:
    // от ознакомления отказа не предусмотрено, и подпись не может внести его в обход.
    const allowed = APPROVAL_KIND_DECISIONS[step.kind as ApprovalStepKind] ?? [];
    if (!allowed.includes(input.decision)) {
      throw coded(
        `На шаге «${APPROVAL_STEP_KIND_LABELS[step.kind as ApprovalStepKind].waiting}» такой исход недоступен`,
        APPROVAL_ERROR_CODES.decisionNotAllowed,
      );
    }
    // Требование шага — минимальная планка. `ecp` строго сильнее `sms` (ст. 49 ЦК),
    // поэтому квалифицированная подпись закрывает и тот шаг, где хватало простой;
    // наоборот — нет, и это ровно та ошибка, ради которой поле и заведено.
    if (step.requiredSignatureKind === 'ecp' && input.signatureKind !== 'ecp') {
      throw coded(
        'Этот шаг закрывается только квалифицированной электронной подписью',
        SIGN_APPROVAL_NEEDS_SIGNATURE,
      );
    }

    await this.applyDecision(tx, step, userId, {
      decision: input.decision,
      comment: input.comment?.trim() || null,
      subjectSha256: input.subjectSha256,
      signatureKind: input.signatureKind,
      signActId: input.signActId,
      ip: null,
    });

    // Оповещение — джобом В ЭТОЙ ЖЕ транзакции: «после коммита» здесь наступает
    // не у нас, а у движка подписи, и звать следующую группу напрямую значило бы
    // разослать уведомления по транзакции, которая ещё может откатиться.
    await this.jobs.enqueue(tx, {
      type: APPROVAL_ANNOUNCE_JOB,
      payload: { requestId: step.requestId },
      uniqueKey: `apann:${input.signActId}`,
    });
  }

  /** Оповещение о состоянии заявки — публичный вход для отложенного джоба */
  async announcePublic(requestId: string): Promise<void> {
    await this.announce(requestId);
  }

  /**
   * Паспорт шага для движка подписи: что подписываем, каким уровнем и вправе ли
   * этот человек подписывать.
   *
   * Читающий метод, а не прямое чтение таблиц approvals из core/sign: адресность
   * шага (снимок `awaitingUserIds`) и понятие «активен» принадлежат этому
   * движку, и второе их толкование в чужом модуле разъедется на первой же правке.
   */
  async stepForSignature(
    userId: string,
    stepId: string,
  ): Promise<{
    stepId: string;
    requestId: string;
    refType: string;
    refId: string;
    refTitle: string;
    workspaceId: string | null;
    requiredSignatureKind: ApprovalSignatureRequirement;
    /** `all` — подписать должен каждый адресат, `any` — достаточно одного */
    rule: string;
    /** СНИМОК адресатов шага: под них движок подписи заводит акты одной заявкой */
    awaitingUserIds: string[];
    /** Дедлайн шага: заявка подписи не должна истекать раньше него (dueInHours до 365 суток) */
    deadlineAt: Date | null;
  }> {
    const step = await this.db.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
    if (!step) throw new NotFoundException('Шаг не найден');
    if (step.request.status !== 'pending' || step.status !== 'active') {
      throw coded('Решение по этому шагу уже не требуется', APPROVAL_ERROR_CODES.stepNotActive);
    }
    if (!step.awaitingUserIds.includes(userId)) {
      throw new ForbiddenException({
        message: 'Подписывает адресат шага',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }
    if (step.request.workspaceId && !(await this.isTeamMember(this.db, userId, step.request.workspaceId))) {
      throw new ForbiddenException({
        message: 'Вы больше не работаете в этой организации',
        details: { code: APPROVAL_ERROR_CODES.notAssignee },
      });
    }
    if (!step.requiredSignatureKind) {
      throw coded('Этот шаг закрывается обычным решением, а не подписью', APPROVAL_ERROR_CODES.decisionNotAllowed);
    }
    return {
      stepId: step.id,
      requestId: step.requestId,
      refType: step.request.refType,
      refId: step.request.refId,
      refTitle: step.request.refTitle,
      workspaceId: step.request.workspaceId,
      requiredSignatureKind: step.requiredSignatureKind as ApprovalSignatureRequirement,
      rule: step.rule,
      awaitingUserIds: step.awaitingUserIds,
      deadlineAt: step.deadlineAt,
    };
  }

  /**
   * Проставить требование подписи УЖЕ СОЗДАННЫМ шагам.
   *
   * Обычный путь — поле `requiredSignatureKind` прямо во входе шага при создании
   * заявки: так требование появляется в одной транзакции со строкой шага, до его
   * активации. Этот метод остаётся для доводки существующего маршрута (и для
   * дев-полигона): уровень диктует вид документа, а движок решений про кадровое
   * законодательство ничего не знает и знать не должен.
   */
  async setStepSignatureRequirement(
    tx: Tx | null,
    stepIds: string[],
    kind: ApprovalSignatureRequirement | null,
  ): Promise<void> {
    if (stepIds.length === 0) return;
    const client = tx ?? this.db;
    await client.approvalStep.updateMany({
      where: { id: { in: stepIds }, status: { in: ['waiting', 'active'] } },
      data: { requiredSignatureKind: kind },
    });
  }

  /**
   * ТЕЛО решения — одно на оба входа (клик и подпись).
   *
   * Всё, что здесь написано, — инварианты, каждый из которых куплен отдельной
   * ошибкой: уникальный индекс вместо проверки на двойной клик, `FOR UPDATE`
   * вместо подсчёта «на глаз», статус-гвард вместо «кто первый прочитал».
   * Разделять эту логику по входам НЕЛЬЗЯ: две копии инвариантов разъезжаются.
   */
  private async applyDecision(
    tx: Tx,
    step: {
      id: string;
      requestId: string;
      order: number;
      rule: string;
      awaitingUserIds: string[];
      request: { workspaceId: string | null };
    },
    userId: string,
    input: {
      decision: ApprovalDecisionKind;
      comment: string | null;
      subjectSha256: string | null;
      signatureKind: ApprovalSignatureKind;
      signActId?: string;
      ip?: string | null;
    },
  ): Promise<void> {
    try {
      await tx.approvalDecision.create({
        data: {
          stepId: step.id,
          userId,
          decision: input.decision,
          comment: input.comment,
          subjectSha256: input.subjectSha256,
          signatureKind: input.signatureKind,
          signActId: input.signActId ?? null,
          ip: input.ip ?? null,
        },
      });
    } catch (err) {
      // Уникальный индекс (step, user) — единственная защита от двойного клика и
      // гонки: проверка в приложении здесь принципиально ненадёжна.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
        throw coded('Вы уже вынесли решение по этому шагу', APPROVAL_ERROR_CODES.alreadyDecided);
      }
      throw err;
    }

    if (input.decision !== 'approved') {
      await this.closeRequest(tx, step.requestId, input.decision, step.id);
      return;
    }

    // «Каждый» закрывается, когда ответили все из снимка; «любой из» — сразу.
    let stepDone = true;
    if (step.rule === 'all') {
      // Замок на строке шага СЕРИАЛИЗУЕТ подсчёт. Без него два последних адресата,
      // нажавших в одну секунду, насчитывают каждый N−1 (READ COMMITTED не видит
      // чужую незакоммиченную вставку) и оба выходят молча — шаг остаётся активным
      // навсегда, а самолечения у движка нет. С замком второй считает уже после
      // коммита первого и закрывает шаг.
      await tx.$queryRaw`SELECT id FROM approval_steps WHERE id = ${step.id} FOR UPDATE`;
      const approvals = await tx.approvalDecision.count({
        where: { stepId: step.id, decision: 'approved', userId: { in: step.awaitingUserIds } },
      });
      stepDone = approvals >= step.awaitingUserIds.length;
    }
    if (!stepDone) return;

    // Гонку «двое нажали одновременно» разрешает статус-гвард: продвигает маршрут
    // ровно тот, чей UPDATE поменял строку.
    const won = await tx.approvalStep.updateMany({
      where: { id: step.id, status: 'active' },
      data: { status: 'approved', decidedAt: new Date() },
    });
    if (won.count === 0) return;

    const groupOpen = await tx.approvalStep.count({
      where: { requestId: step.requestId, order: step.order, status: 'active' },
    });
    if (groupOpen > 0) return; // ждём соседей по группе

    const next = await tx.approvalStep.findFirst({
      where: { requestId: step.requestId, status: 'waiting' },
      orderBy: { order: 'asc' },
      select: { order: true },
    });
    if (!next) {
      await this.closeRequest(tx, step.requestId, 'approved', null);
      return;
    }
    await this.activateGroup(tx, step.requestId, next.order, step.request.workspaceId);
  }

  /**
   * Закрыть заявку. Джоб побудки ставится В ТОЙ ЖЕ транзакции (transactional outbox):
   * коммит = хук ведущего гарантированно сработает, откат = его не было. Звать
   * движок Процессов прямо отсюда нельзя — это чужие замки внутри нашей транзакции.
   */
  private async closeRequest(
    tx: Tx,
    requestId: string,
    outcome: 'approved' | 'rejected' | 'returned',
    exceptStepId: string | null,
  ): Promise<void> {
    const now = new Date();

    if (exceptStepId) {
      await tx.approvalStep.updateMany({
        where: { id: exceptStepId, status: 'active' },
        data: { status: outcome, decidedAt: now },
      });
    }
    // Остальные незакрытые шаги гасим: спрашивать дальше нечего, но и «согласовано»
    // им не приписываем — они именно ПРОПУЩЕНЫ.
    await tx.approvalStep.updateMany({
      where: { requestId, status: { in: ['active', 'waiting'] } },
      data: { status: 'skipped' },
    });

    const closed = await tx.approvalRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: outcome, finishedAt: now },
    });
    if (closed.count === 0) return; // кто-то закрыл раньше — второй раз не будим

    await this.jobs.enqueue(tx, {
      type: APPROVAL_RESOLVED_JOB,
      payload: { requestId },
      uniqueKey: `apres:${requestId}`,
    });
  }

  /**
   * Оповестить о ТЕКУЩЕМ состоянии заявки. Один путь на создание и на решение:
   * заявка либо ждёт кого-то (зовём активные шаги), либо закрыта (сообщаем автору).
   *
   * Всегда ПОСЛЕ коммита и best-effort: упавшая лента не имеет права уронить уже
   * принятое решение (то же правило, что у сброса пароля в AuthService).
   */
  private async announce(requestId: string): Promise<void> {
    const request = await this.db.approvalRequest.findUnique({
      where: { id: requestId },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!request) return;

    if (request.status === 'pending') {
      const active = request.steps.filter((s) => s.status === 'active');
      for (const step of active) await this.notifyStep(request.refTitle, request.workspaceId, step);
      return;
    }

    const last = [...request.steps].reverse().find((s) => s.decidedAt);
    await this.notifications
      .notify(
        request.createdById,
        'approval.resolved',
        {
          refTitle: request.refTitle,
          outcomeLabel: APPROVAL_REQUEST_STATUS_LABELS[request.status as keyof typeof APPROVAL_REQUEST_STATUS_LABELS],
          comment: last ? ((await this.lastComment(last.id)) ?? '') : '',
        },
        { actionUrl: this.hrefFor(request.workspaceId, request.id) },
      )
      .catch(() => undefined);
  }

  private async lastComment(stepId: string): Promise<string | null> {
    const row = await this.db.approvalDecision.findFirst({
      where: { stepId, comment: { not: null } },
      orderBy: { decidedAt: 'desc' },
      select: { comment: true },
    });
    return row?.comment ?? null;
  }

  /** Позвать адресатов активированного шага; пустой снимок — тупик, о нём сообщаем автору */
  private async notifyStep(
    refTitle: string,
    workspaceId: string | null,
    step: { id: string; kind: string; title: string; awaitingUserIds: string[]; assigneeLabel: string | null; requestId: string },
  ): Promise<void> {
    const labels = APPROVAL_STEP_KIND_LABELS[step.kind as ApprovalStepKind];
    const actionUrl = this.hrefFor(workspaceId, step.requestId);

    if (step.awaitingUserIds.length === 0) {
      const request = await this.db.approvalRequest.findUnique({
        where: { id: step.requestId },
        select: { createdById: true },
      });
      if (request) {
        await this.notifications
          .notify(
            request.createdById,
            'approval.unassigned',
            { refTitle, stepTitle: step.title, assigneeLabel: step.assigneeLabel ?? 'выбранной группе' },
            { actionUrl, dedupKey: `apun:${step.id}` },
          )
          .catch(() => undefined);
      }
      return;
    }

    for (const uid of step.awaitingUserIds) {
      await this.notifications
        .notify(
          uid,
          'approval.requested',
          { refTitle, stepTitle: step.title, actionLabel: labels.action },
          { actionUrl, dedupKey: `apreq:${step.id}:${uid}` },
        )
        .catch(() => undefined);
    }
  }

  /**
   * Адрес карточки заявки — общий хелпер shared (собирать строку на месте нельзя:
   * копии разъезжаются). Рабочая заявка адресуется ВНУТРЬ организации: иначе
   * каркас веба, который выводит контекст из адреса, показывает документ
   * организации в «Личном».
   */
  private hrefFor(workspaceId: string | null, requestId: string): string {
    return approvalHref(requestId, workspaceId);
  }

  // ============================================================
  // Отмена
  // ============================================================

  async cancel(userId: string, requestId: string): Promise<void> {
    const request = await this.db.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Заявка не найдена');
    if (request.createdById !== userId) throw new ForbiddenException('Отменить может только автор заявки');
    if (request.status !== 'pending') return;
    // Отзыв автором — ведущего БУДИМ: шаг маршрута, который ждал это решение, иначе
    // остаётся активным навсегда (решать его уже некому), а вместе с ним висит и
    // запуск процесса, и предмет с закрытой правкой.
    await this.cancelInternal(requestId, { notifyOrigin: true });
  }

  /**
   * Системная отмена: процесс отменили — его заявки больше никого не ждут.
   * Хук ведущего при этом НЕ зовём: инициатор здесь он сам.
   */
  async cancelByOrigin(originType: string, originRef: string): Promise<void> {
    const rows = await this.db.approvalRequest.findMany({
      where: { originType, originRef, status: 'pending' },
      select: { id: true },
    });
    for (const r of rows) await this.cancelInternal(r.id, { notifyOrigin: false });
  }

  /** Отменить ВСЕ живые заявки на предмет (предмет отменён/удалён его сервисом) */
  async cancelForRef(refType: string, refId: string): Promise<void> {
    const rows = await this.db.approvalRequest.findMany({
      where: { refType, refId, status: 'pending' },
      select: { id: true },
    });
    for (const r of rows) await this.cancelInternal(r.id, { notifyOrigin: false });
  }

  private async cancelInternal(requestId: string, opts: { notifyOrigin: boolean }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.approvalStep.updateMany({
        where: { requestId, status: { in: ['active', 'waiting'] } },
        data: { status: 'skipped' },
      });
      const closed = await tx.approvalRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      if (closed.count === 0 || !opts.notifyOrigin) return;
      const request = await tx.approvalRequest.findUnique({
        where: { id: requestId },
        select: { originType: true },
      });
      if (!request?.originType) return;
      // Тот же transactional outbox, что у обычного закрытия: коммит = ведущий узнает.
      await this.jobs.enqueue(tx, {
        type: APPROVAL_RESOLVED_JOB,
        payload: { requestId },
        uniqueKey: `apres:${requestId}`,
      });
    });
  }

  // ============================================================
  // Стопка «Ждут решения»
  // ============================================================

  /**
   * Что ждёт этого человека. ОДИН индексный запрос по GIN-индексу снимка: движок
   * прав здесь не участвует вовсе — вся адресация уже развёрнута в людей при
   * активации шага.
   */
  private pendingWhere(userId: string, scope: InboxScope): Prisma.ApprovalStepWhereInput {
    return {
      status: 'active',
      awaitingUserIds: { has: userId },
      decisions: { none: { userId } },
      request: { status: 'pending', ...this.scopeWhere(scope) },
    };
  }

  /**
   * Скоуп → условие по заявке. ОДНА точка разрешения на все витрины (стопка,
   * счётчик бейджа, «мои заявки»): организация сильнее «только личного», пустой
   * скоуп = сквозной вид.
   *
   * Третье состояние здесь не для красоты: «личное» и «всё» одинаково приходят без
   * `workspaceId`, и пока их не различали, личная Главная показывала человеку с
   * пятью компаниями всё вперемешку.
   */
  private scopeWhere(scope: InboxScope): Prisma.ApprovalRequestWhereInput {
    if (scope.workspaceId) return { workspaceId: scope.workspaceId };
    if (scope.personalOnly) return { workspaceId: null };
    return {};
  }

  /** Разбор скоупа из query: `workspaceId` сильнее `scope=personal` */
  private scopeOf(q: { workspaceId?: string; scope?: ApprovalInboxScope }): InboxScope {
    if (q.workspaceId) return { workspaceId: q.workspaceId };
    return { personalOnly: q.scope === 'personal' };
  }

  async countPending(userId: string, scope: InboxScope): Promise<number> {
    return this.db.approvalStep.count({ where: this.pendingWhere(userId, scope) });
  }

  async listPending(userId: string, limit: number, scope: InboxScope): Promise<InboxItemDto[]> {
    const steps = await this.db.approvalStep.findMany({
      where: this.pendingWhere(userId, scope),
      include: { request: true },
      // Срочное первым: Postgres в ASC кладёт NULL в конец, поэтому бессрочные шаги
      // сами оказываются после датированных.
      orderBy: [{ deadlineAt: 'asc' }, { activatedAt: 'asc' }],
      take: limit,
    });

    const now = Date.now();
    return steps.map((step) => {
      const labels = APPROVAL_STEP_KIND_LABELS[step.kind as ApprovalStepKind];
      const allowed = APPROVAL_KIND_DECISIONS[step.kind as ApprovalStepKind] ?? [];
      return {
        sourceKey: INBOX_SOURCE_KEYS.approval,
        id: step.id,
        title: step.request.refTitle,
        subtitle: step.title,
        icon: step.request.refIcon ?? labels.icon,
        href: this.hrefFor(step.request.workspaceId, step.requestId),
        stepKind: step.kind as ApprovalStepKind,
        signRequirement: (step.requiredSignatureKind as ApprovalSignatureRequirement | null) ?? null,
        // Шаг, который закрывается ПОДПИСЬЮ, кнопок в стопке не получает: подпись
        // собирается на своём экране (соглашение сторон, код или ключ ЭЦП), и
        // «Согласовать» одним нажатием здесь было бы обманом.
        actions: (step.requiredSignatureKind ? [] : allowed).map((decision) => ({
          key: decision,
          label:
            decision === 'approved'
              ? labels.action
              : decision === 'rejected'
                ? 'Отклонить'
                : 'На доработку',
          tone: decision === 'approved' ? 'primary' : decision === 'rejected' ? 'danger' : 'default',
          commentRequired: APPROVAL_DECISIONS_NEEDING_COMMENT.includes(decision),
        })),
        requestedById: step.request.createdById,
        createdAt: (step.activatedAt ?? step.request.createdAt).toISOString(),
        dueAt: step.deadlineAt?.toISOString() ?? null,
        overdue: !!step.deadlineAt && step.deadlineAt.getTime() < now,
      };
    });
  }

  /** Стопка целиком — по РЕЕСТРУ источников, а не по своей таблице */
  async inbox(
    userId: string,
    q: { workspaceId?: string; scope?: ApprovalInboxScope; sourceKey?: string },
  ): Promise<InboxPageDto> {
    const scope = this.scopeOf(q);
    const sources = this.registry
      .sourceEntries()
      .filter(([key]) => !q.sourceKey || key === q.sourceKey);

    const results = await Promise.all(
      sources.map(async ([key, source]) => {
        try {
          return { key, items: await source.list(userId, APPROVAL_LIMITS.inboxPerSource, scope) };
        } catch (err) {
          // Упавший источник не имеет права обнулить всю стопку: остальные строки
          // человек увидит, а сбой попадёт в лог.
          this.logger.error(`источник стопки "${key}": ${(err as Error).message}`);
          return { key, items: [] as InboxItemDto[] };
        }
      }),
    );

    const items = results.flatMap((r) => r.items).sort(this.byUrgency);
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.key] = r.items.length;

    const actorIds = [...new Set(items.map((i) => i.requestedById).filter((v): v is string => !!v))];
    return { items, actors: await this.actorsOf(actorIds), counts, total: items.length };
  }

  async inboxCount(
    userId: string,
    q: { workspaceId?: string; scope?: ApprovalInboxScope },
  ): Promise<InboxCountDto> {
    const scope = this.scopeOf(q);
    const entries = await Promise.all(
      this.registry.sourceEntries().map(async ([key, source]) => {
        try {
          return [key, await source.count(userId, scope)] as const;
        } catch {
          return [key, 0] as const;
        }
      }),
    );
    const counts = Object.fromEntries(entries);
    return { total: entries.reduce((sum, [, n]) => sum + n, 0), counts };
  }

  /** Просроченное вперёд, затем по сроку, затем старое — стопка разгребается сверху */
  private byUrgency = (a: InboxItemDto, b: InboxItemDto): number => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  };

  // ============================================================
  // Чтение
  // ============================================================

  async get(userId: string, requestId: string): Promise<ApprovalRequestDto> {
    const request = await this.db.approvalRequest.findUnique({
      where: { id: requestId },
      include: {
        steps: {
          orderBy: [{ order: 'asc' }],
          include: { decisions: { orderBy: { decidedAt: 'asc' } } },
        },
      },
    });
    if (!request) throw new NotFoundException('Заявка не найдена');

    const participates =
      request.createdById === userId ||
      request.steps.some((s) => s.awaitingUserIds.includes(userId) || s.decisions.some((d) => d.userId === userId));

    if (!participates) {
      const canView = await this.registry.get(request.refType)?.canView?.(userId, request.refId);
      if (!canView) throw new NotFoundException('Заявка не найдена');
    }

    const provider = this.registry.get(request.refType);
    const ref = (await provider?.describeRef?.(request.refId)) ?? null;

    const now = Date.now();
    const steps: ApprovalStepDto[] = request.steps.map((s) => ({
      id: s.id,
      order: s.order,
      kind: s.kind as ApprovalStepKind,
      title: s.title,
      status: s.status as ApprovalStepDto['status'],
      assigneeType: s.assigneeType as ApprovalStepDto['assigneeType'],
      assigneeId: s.assigneeId,
      assigneeLabel: s.assigneeLabel,
      rule: s.rule as ApprovalStepDto['rule'],
      awaitingUserIds: s.awaitingUserIds,
      decisions: s.decisions.map((d) => ({
        id: d.id,
        userId: d.userId,
        decision: d.decision as ApprovalDecisionKind,
        comment: d.comment,
        decidedAt: d.decidedAt.toISOString(),
        signatureKind: d.signatureKind as ApprovalSignatureKind,
        subjectSha256: d.subjectSha256,
        signActId: d.signActId,
      })),
      dueAt: s.deadlineAt?.toISOString() ?? null,
      overdue: s.status === 'active' && !!s.deadlineAt && s.deadlineAt.getTime() < now,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      requiredSignatureKind: (s.requiredSignatureKind as ApprovalSignatureRequirement | null) ?? null,
    }));

    const myStep = request.steps.find(
      (s) => s.status === 'active' && s.awaitingUserIds.includes(userId) && !s.decisions.some((d) => d.userId === userId),
    );

    const actorIds = [
      ...new Set([
        request.createdById,
        ...request.steps.flatMap((s) => [...s.awaitingUserIds, ...s.decisions.map((d) => d.userId)]),
      ]),
    ];

    return {
      id: request.id,
      refType: request.refType,
      refId: request.refId,
      refTitle: request.refTitle,
      refIcon: request.refIcon,
      ref: ref ? { title: ref.title, icon: ref.icon ?? null, href: ref.href ?? null } : null,
      status: request.status as ApprovalRequestDto['status'],
      workspaceId: request.workspaceId,
      createdById: request.createdById,
      createdAt: request.createdAt.toISOString(),
      finishedAt: request.finishedAt?.toISOString() ?? null,
      steps,
      actors: await this.actorsOf(actorIds),
      myStepId: myStep?.id ?? null,
      myDecisions: request.steps
        .flatMap((s) => s.decisions)
        .filter((d) => d.userId === userId)
        .map((d) => d.decision as ApprovalDecisionKind),
      canCancel: request.createdById === userId && request.status === 'pending',
    };
  }

  /** «Мои заявки»: где сейчас то, что я отправил */
  async listMine(
    userId: string,
    q: { workspaceId?: string; scope?: ApprovalInboxScope; archived?: boolean; cursor?: string },
  ): Promise<ApprovalMinePage> {
    const rows = await this.db.approvalRequest.findMany({
      where: {
        createdById: userId,
        ...this.scopeWhere(this.scopeOf(q)),
        status: q.archived ? { not: 'pending' } : 'pending',
        ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
      },
      include: { steps: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: APPROVAL_LIMITS.pageSize + 1,
    });

    const page = rows.slice(0, APPROVAL_LIMITS.pageSize);
    const now = Date.now();

    const items = page.map((r) => {
      const active = r.steps.find((s) => s.status === 'active');
      const groups = [...new Set(r.steps.map((s) => s.order))];
      const stageLabel =
        r.status !== 'pending'
          ? APPROVAL_REQUEST_STATUS_LABELS[r.status as keyof typeof APPROVAL_REQUEST_STATUS_LABELS]
          : active
            ? `Шаг ${groups.indexOf(active.order) + 1} из ${groups.length} · ${APPROVAL_STEP_KIND_LABELS[active.kind as ApprovalStepKind].waiting}`
            : 'Ждёт решения';

      return {
        id: r.id,
        refType: r.refType,
        refTitle: r.refTitle,
        refIcon: r.refIcon,
        href: this.hrefFor(r.workspaceId, r.id),
        status: r.status as ApprovalMinePage['items'][number]['status'],
        stageLabel,
        awaitingUserIds: active?.awaitingUserIds ?? [],
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        dueAt: active?.deadlineAt?.toISOString() ?? null,
        overdue: !!active?.deadlineAt && active.deadlineAt.getTime() < now,
      };
    });

    const actorIds = [...new Set(items.flatMap((i) => i.awaitingUserIds))];
    return {
      items,
      actors: await this.actorsOf(actorIds),
      nextCursor: rows.length > APPROVAL_LIMITS.pageSize ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  /**
   * Предметы, по которым человек РЕШАЕТ или уже решил.
   *
   * Нужен потребителям для их СПИСКОВ: согласующий обязан видеть предмет своего
   * решения, а адресность живёт только здесь (снимок шага). Отдаём id одним условием
   * для чужого SQL — тот же приём, что `grantSetFor` у движка прав.
   */
  async refIdsInvolving(userId: string, refType: string, workspaceId?: string): Promise<string[]> {
    const rows = await this.db.approvalRequest.findMany({
      where: {
        refType,
        ...(workspaceId ? { workspaceId } : {}),
        steps: {
          some: {
            OR: [{ awaitingUserIds: { has: userId } }, { decisions: { some: { userId } } }],
          },
        },
      },
      select: { refId: true },
      take: APPROVAL_LIMITS.involvedRefsCap,
    });
    return [...new Set(rows.map((r) => r.refId))];
  }

  /** Живая заявка на предмет — карточка потребителя ведёт по ней на маршрут решения */
  async activeRequestIdForRef(refType: string, refId: string): Promise<string | null> {
    const row = await this.db.approvalRequest.findFirst({
      where: { refType, refId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Он адресат (или уже решил) по ЭТОМУ предмету — точечная проверка для карточки */
  async isInvolvedInRef(userId: string, refType: string, refId: string): Promise<boolean> {
    const count = await this.db.approvalRequest.count({
      where: {
        refType,
        refId,
        steps: {
          some: {
            OR: [{ awaitingUserIds: { has: userId } }, { decisions: { some: { userId } } }],
          },
        },
      },
    });
    return count > 0;
  }

  /** Человек в UI = карточка (Принцип 2), поэтому батч лайт-профилей, а не голые id */
  private async actorsOf(ids: string[]): Promise<Record<string, ApprovalActorLite>> {
    if (ids.length === 0) return {};
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return Object.fromEntries(users.map((u) => [u.id, u as ApprovalActorLite]));
  }
}
