import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ESUTD_KINDS,
  HR_ACTION_KIND_LABELS,
  HR_DEADLINE_RULE_MAP,
  HR_ERROR_CODES,
  HR_LIMITS,
  ST54_BAN_EXCEPTION_GROUNDS,
  WORKSPACE_ROLE_RANK,
  isEmployerInitiativeGround,
  hrMemberHref,
  type CreateHrActionInput,
  type CreateHrBatchInput,
  type HrActionBatchDto,
  type HrActionDto,
  type HrActionKind,
  type HrActionStatus,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { StaffService } from '../staff/staff.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { HrCalendarService } from './hr-calendar.service';
import {
  HR_APPLY_JOB,
  HR_BATCH_JOB,
  HR_MEMBER_REF_TYPE,
  assertCanManageHrSubject,
  canManageHrSubject,
  hrMemberRefId,
} from './hr.constants';
import { fullName } from '../../shared/utils/user-name';

const WS_CONTEXT = 'workspace';

/** Клиент внутри интерактивной транзакции Prisma (применение действия — одним коммитом) */
type HrTx = Parameters<Parameters<DatabaseService['$transaction']>[0]>[0];

/** Строка кадрового действия, как её отдаёт Prisma */
type HrActionRow = Awaited<ReturnType<DatabaseService['hrAction']['findUniqueOrThrow']>>;

/**
 * Эффекты, которые нельзя исполнять внутри транзакции применения: они ходят в
 * чужие сервисы со своими транзакциями и каскадами. Описываются в теле tx,
 * исполняются после коммита.
 */
interface PostApplyEffects {
  syncFact?: { positionId: string; branchId: string | null; prevPositionId: string | null };
  removeMembership?: boolean;
}

const dateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

function coded(message: string, code: string): BadRequestException {
  return new BadRequestException({ message, details: { code } });
}

/**
 * Кадровые действия (КЭДО): действие ПЕРВИЧНО, документ производен.
 * «Уволить» → приказ (черновик, правится) → отправка на маршрут → подписи →
 * нода hr.apply → применение В ДАТУ вступления в силу (но не раньше подписи).
 *
 * Проверка законности (ст. 54 ТК РК) повторяется В МОМЕНТ применения: между
 * подписью и датой вступления человек мог уйти в отпуск. Границы данных
 * честные: отпуска — по данным системы, больничные системе неизвестны.
 */
@Injectable()
export class HrActionsService {
  private readonly logger = new Logger(HrActionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly documents: DocumentsService,
    private readonly staff: StaffService,
    private readonly tasks: TasksService,
    private readonly workspaces: WorkspacesService,
    private readonly calendar: HrCalendarService,
  ) {}

  // ---------- Гейты (копия лестницы — прецедент documents/processes) ----------

  private async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  private isManager(role: WorkspaceRole | null): boolean {
    return !!role && (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  }

  private async requireManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role || role === 'contractor') throw new ForbiddenException('Нет доступа к этой организации');
    if (!this.isManager(role)) throw new ForbiddenException('Кадровые действия ведёт Менеджер или выше');
    return role;
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? fullName(u) : 'Кто-то';
  }

  private async logMember(
    actorId: string | null,
    workspaceId: string,
    subjectUserId: string,
    typeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.chatter
      .log(null, {
        refType: HR_MEMBER_REF_TYPE,
        refId: hrMemberRefId(workspaceId, subjectUserId),
        workspaceId,
        actorId: actorId ?? undefined,
        actorName: actorId ? await this.nameOf(actorId) : 'Система',
        typeKey,
        payload,
      })
      .catch(() => undefined);
  }

  // ============================================================
  // Создание действия
  // ============================================================

  async createAction(
    actorId: string,
    workspaceId: string,
    dto: CreateHrActionInput,
    opts: { batchId?: string } = {},
  ): Promise<HrActionDto> {
    const actorRole = await this.requireManager(actorId, workspaceId);
    const subjectRole = await this.roleOf(dto.userId, workspaceId);
    if (!subjectRole || subjectRole === 'contractor') {
      throw new BadRequestException('Кадровое действие заводится на сотрудника организации');
    }
    assertCanManageHrSubject(actorRole, subjectRole);
    const kind = dto.kind as HrActionKind;
    const params = dto.params ?? {};

    // Обязательное по виду — проверяем ЗДЕСЬ, а не в Zod: параметры дополняют
    // друг друга, и только сервис знает, что для какого вида несущее.
    if (kind === 'leave' && !dto.effectiveTo) throw new BadRequestException('У отпуска обязательна дата окончания');
    if (kind === 'dismissal' && !params.ground) throw new BadRequestException('Укажите основание прекращения (статья ТК РК)');
    if (kind === 'transfer' && !params.legalPositionId) throw new BadRequestException('Укажите новую должность');
    if (kind === 'salary_change' && params.salaryAmount === undefined) throw new BadRequestException('Укажите новый оклад');

    /**
     * Дубль незакрытого действия. Два приказа применятся ОБА, и разбираться с
     * этим придётся уже в юридических последствиях. Но «второе такое же» — не
     * всегда ошибка: перевод, запланированный на 1 сентября, законно соседствует
     * с переводом, оформляемым сегодня. Поэтому ловим ровно два случая:
     *   • тот же вид В ТУ ЖЕ ДАТУ вступления — двойной клик или второй кадровик;
     *   • второе увольнение — их у человека не бывает двух ни при какой дате.
     */
    if (!opts.batchId) {
      const openSame = await this.db.hrAction.findFirst({
        where: {
          workspaceId,
          userId: dto.userId,
          kind,
          status: { in: ['draft', 'in_progress', 'scheduled'] },
          ...(kind === 'dismissal' ? {} : { effectiveAt: new Date(dto.effectiveAt) }),
        },
        select: { id: true },
      });
      if (openSame) {
        throw coded(
          kind === 'dismissal'
            ? 'По этому сотруднику уже идёт увольнение — закройте или отмените его прежде, чем заводить новое'
            : `По этому сотруднику уже идёт действие «${HR_ACTION_KIND_LABELS[kind]}» на эту же дату — закройте или отмените его прежде, чем заводить новое`,
          HR_ERROR_CODES.actionDuplicate,
        );
      }
    }

    // ЧЕСТНЫЙ ОТКАЗ ПРИ СТАРТЕ: у шаблона приказа обязан быть опубликованный
    // маршрут с нодой hr.apply — иначе действие тихо не применилось бы никогда
    // (валидация «маршрут есть, ноды нет» не ловит случай «маршрута нет вовсе»).
    await this.assertApplyRoute(workspaceId, dto.templateId);

    // Дата за горизонтом производственного календаря — тоже честный отказ:
    // у действия сроки ЕСУТД считаются в РАБОЧИХ днях, и пессимистичный счёт
    // здесь — это недосчёт, то есть штраф (ст. 98 КоАП). Отпуск сроков не
    // рождает — его пускаем.
    if (kind !== 'leave') this.calendar.assertCovered(dto.effectiveAt);

    // Приём: черновик трудовой карточки заводится сразу (применение в hiredAt
    // переведёт в active). Прочие виды требуют живую карточку — их применение
    // меняет её поля, и применять было бы нечего.
    let employmentId: string | null = null;
    const live = await this.db.employment.findFirst({
      where: { workspaceId, userId: dto.userId, status: { not: 'terminated' } },
      orderBy: { createdAt: 'desc' },
    });
    if (kind === 'hire') {
      if (live && live.status === 'active') {
        throw new BadRequestException('У сотрудника уже есть действующая трудовая карточка');
      }
      const snapshots = params.legalPositionId
        ? await this.legalSnapshots(workspaceId, params.legalPositionId, params.legalBranchId ?? null)
        : { positionName: null, branchName: null };
      const draft =
        live ??
        (await this.db.employment.create({
          data: { workspaceId, userId: dto.userId, status: 'draft', createdById: actorId },
        }));
      await this.db.employment.update({
        where: { id: draft.id },
        data: {
          hiredAt: new Date(dto.effectiveAt),
          contractType: params.contractType ?? 'indefinite',
          contractNumber: params.contractNumber ?? null,
          contractDate: params.contractDate ? new Date(params.contractDate) : null,
          contractEndAt: params.contractEndAt ? new Date(params.contractEndAt) : null,
          probationUntil: params.probationUntil ? new Date(params.probationUntil) : null,
          workRate: params.workRate ?? 1,
          workSchedule: params.workSchedule ?? null,
          salaryAmount: params.salaryAmount !== undefined ? BigInt(params.salaryAmount) : null,
          paperMode: params.paperMode ?? false,
          personnelNumber: params.personnelNumber ?? null,
          ...(params.legalPositionId
            ? {
                legalPositionId: params.legalPositionId,
                legalPositionName: snapshots.positionName,
                legalBranchId: params.legalBranchId ?? null,
                legalBranchName: snapshots.branchName,
              }
            : {}),
        },
      });
      employmentId = draft.id;
    } else {
      if (!live) throw new BadRequestException('Сначала заведите трудовую карточку (или оформите приём)');
      employmentId = live.id;
    }

    const action = await this.db.hrAction.create({
      data: {
        workspaceId,
        userId: dto.userId,
        kind,
        status: 'draft',
        source: 'employer',
        effectiveAt: new Date(dto.effectiveAt),
        effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
        params: params as object,
        employmentId,
        // Пачка проставляет свой id СРАЗУ: дописанный вторым запросом, он терялся
        // при обрыве джоба, и ретрай заводил человеку ВТОРОЕ действие с приказом.
        ...(opts.batchId ? { batchId: opts.batchId } : {}),
        createdById: actorId,
      },
    });

    // Документы действия: приказ + (у приёма) пакет. Первый — ГЛАВНЫЙ: его
    // отмена/отклонение двигает статус действия.
    const templateIds = [dto.templateId, ...(dto.packageTemplateIds ?? [])];
    const docIds: string[] = [];
    for (const templateId of templateIds) {
      const doc = await this.documents.systemCreateForHrAction({
        workspaceId,
        templateId,
        actorId,
        subjectUserId: dto.userId,
        hrActionId: action.id,
        fields: dto.fields ?? {},
      });
      docIds.push(doc.id);
    }
    await this.db.hrAction.update({
      where: { id: action.id },
      data: { params: { ...(params as object), orderDocumentId: docIds[0] } as object },
    });

    await this.logMember(actorId, workspaceId, dto.userId, 'hr.action_created', {
      kindLabel: HR_ACTION_KIND_LABELS[kind],
      documentSuffix: docIds.length ? ` (документов: ${docIds.length})` : '',
    });

    return this.getAction(workspaceId, action.id);
  }

  private async legalSnapshots(workspaceId: string, positionId: string, branchId: string | null, tx?: HrTx) {
    const db = tx ?? this.db;
    const pos = await db.staffPosition.findFirst({ where: { id: positionId, workspaceId }, select: { name: true } });
    if (!pos) throw new BadRequestException('Должность не найдена в этой организации');
    let branchName: string | null = null;
    if (branchId) {
      const br = await db.staffBranch.findFirst({ where: { id: branchId, workspaceId }, select: { name: true } });
      if (!br) throw new BadRequestException('Филиал не найден в этой организации');
      branchName = br.name;
    }
    return { positionName: pos.name, branchName };
  }

  /** Есть ли у шаблона опубликованный маршрут с нодой hr.apply — честный отказ при старте */
  private async assertApplyRoute(workspaceId: string, templateId: string): Promise<void> {
    const triggers = await this.db.processTrigger.findMany({
      where: { workspaceId, type: 'document', enabled: true, definition: { status: 'active' } },
      select: { definitionId: true, config: true },
    });
    const trigger = triggers.find(
      (t) => ((t.config ?? {}) as { templateId?: string }).templateId === templateId,
    );
    if (!trigger) {
      throw coded(
        'У шаблона приказа нет опубликованного маршрута — без него действие никогда не применится. Откройте шаблон и настройте «Маршрут»',
        HR_ERROR_CODES.noApplyRoute,
      );
    }
    const def = await this.db.processDefinition.findUnique({
      where: { id: trigger.definitionId },
      select: { currentVersionId: true },
    });
    const version = def?.currentVersionId
      ? await this.db.processVersion.findUnique({ where: { id: def.currentVersionId }, select: { document: true } })
      : null;
    const nodes = ((version?.document ?? {}) as { nodes?: { type?: string }[] }).nodes ?? [];
    if (!nodes.some((n) => n.type === 'hr.apply')) {
      throw coded(
        'В маршруте шаблона нет ноды «Применить кадровое действие» — подписанный приказ не изменит данные. Добавьте её на канвас',
        HR_ERROR_CODES.noApplyRoute,
      );
    }
  }

  // ============================================================
  // Машина состояний (порт для «Документооборота» — ленивое ребро)
  // ============================================================

  /** Приказ действия ушёл на маршрут → действие «на оформлении» */
  async onDocumentSubmitted(hrActionId: string): Promise<void> {
    await this.db.hrAction.updateMany({
      where: { id: hrActionId, status: 'draft' },
      data: { status: 'in_progress' },
    });
  }

  /** Приказ вернули в черновик (withdraw) → и действие обратно в черновик */
  async onDocumentWithdrawn(hrActionId: string): Promise<void> {
    await this.db.hrAction.updateMany({
      where: { id: hrActionId, status: 'in_progress' },
      data: { status: 'draft' },
    });
  }

  /** Маршрут приказа отклонён/на доработку → действие в черновик (правится и уходит заново) */
  async onDocumentResolved(hrActionId: string, outcome: 'approved' | 'rejected' | 'returned' | 'cancelled'): Promise<void> {
    if (outcome === 'rejected' || outcome === 'returned') {
      await this.db.hrAction.updateMany({
        where: { id: hrActionId, status: 'in_progress' },
        data: { status: 'draft' },
      });
    }
  }

  /** Приказ отменён → действие отменено (если ещё не применено) */
  async onDocumentCancelled(hrActionId: string, documentId: string): Promise<void> {
    const action = await this.db.hrAction.findUnique({ where: { id: hrActionId } });
    if (!action) return;
    const orderDocumentId = (action.params as { orderDocumentId?: string }).orderDocumentId;
    if (orderDocumentId && orderDocumentId !== documentId) return; // отменили не приказ, а документ пакета
    await this.db.hrAction.updateMany({
      where: { id: hrActionId, status: { in: ['draft', 'in_progress', 'scheduled'] } },
      data: { status: 'cancelled' },
    });
  }

  /**
   * Нода `hr.apply`: маршрут дошёл до применения. Дата вступления уже наступила →
   * применяем сейчас; в будущем → `scheduled` + отложенный джоб на дату (правило:
   * «в дату вступления в силу, но не раньше подписи»).
   */
  async onRouteReachedApply(hrActionId: string): Promise<{ scheduled: boolean }> {
    const action = await this.db.hrAction.findUnique({ where: { id: hrActionId } });
    if (!action) throw new NotFoundException('Кадровое действие не найдено');
    if (action.status === 'applied') return { scheduled: false };
    if (['cancelled', 'failed'].includes(action.status)) return { scheduled: false };

    const today = this.calendar.today();
    const effective = dateStr(action.effectiveAt)!;
    if (effective <= today) {
      await this.applyAction(action.id);
      return { scheduled: false };
    }
    const claimed = await this.db.hrAction.updateMany({
      where: { id: action.id, status: { in: ['draft', 'in_progress'] } },
      data: { status: 'scheduled' },
    });
    if (claimed.count > 0) {
      // ~08:00 по Алматы даты вступления (03:00 UTC): кадровик приходит к уже применённому
      await this.jobs.enqueue(null, {
        type: HR_APPLY_JOB,
        payload: { hrActionId: action.id },
        runAt: new Date(`${effective}T03:00:00.000Z`),
        uniqueKey: `hrapply:${action.id}`,
      });
    }
    return { scheduled: true };
  }

  // ============================================================
  // Применение
  // ============================================================
  /**
   * Применить действие. Идемпотентно (статус-клейм); ошибка проверки законности —
   * НЕ исключение, а честный `failed` с причиной и уведомлением: джоб не должен
   * молотить ретраями то, что чинится только человеком.
   *
   * КЛЕЙМ И ЭФФЕКТЫ — В ОДНОЙ ТРАНЗАКЦИИ (правило платформы «клейм не коммитить
   * до эффекта»): раньше статус `applied` коммитился первым, и падение процесса
   * между ним и правкой карточки (деплой, обрыв соединения с БД) теряло
   * применение НАВСЕГДА — повтор джоба видел «уже применено» и тихо выходил, а
   * данные оставались старыми. Всё, что уходит в чужие сервисы (членство,
   * факт-назначение, уведомления, хроника), исполняется ПОСЛЕ коммита: держать
   * чужие замки внутри своей транзакции нельзя.
   */
  async applyAction(hrActionId: string): Promise<void> {
    let outcome:
      | { kind: 'applied'; action: HrActionRow; post: PostApplyEffects }
      | { kind: 'failed'; action: HrActionRow; reason: string }
      | null = null;

    try {
      outcome = await this.db.$transaction(async (tx) => {
        // Клейм принимает и `draft`: маршрут дошёл до ноды «Применить», а хук
        // `onDocumentSubmitted` мог не доехать (он best-effort). Отказать здесь
        // значило бы отчитаться «применено» и не применить — асимметрия с веткой
        // будущей даты, которая draft принимала с самого начала.
        const claimed = await tx.hrAction.updateMany({
          where: { id: hrActionId, status: { in: ['draft', 'in_progress', 'scheduled'] } },
          data: { status: 'applied', appliedAt: new Date() },
        });
        if (claimed.count === 0) return null;
        const action = await tx.hrAction.findUniqueOrThrow({ where: { id: hrActionId } });

        const legality = await this.checkLegality(tx, action);
        if (!legality.ok) {
          await tx.hrAction.update({
            where: { id: action.id },
            data: { status: 'failed', appliedAt: null, failReason: legality.reason },
          });
          return { kind: 'failed' as const, action, reason: legality.reason ?? 'проверка законности' };
        }
        const post = await this.applyEffectsTx(tx, action);
        return { kind: 'applied' as const, action, post };
      });
    } catch (e) {
      // Применение упало на данных — честный failed, не вечный ретрай. Транзакция
      // откатилась целиком, поэтому статус проставляем отдельной записью.
      const reason = (e as Error).message;
      const action = await this.db.hrAction.findUnique({ where: { id: hrActionId } });
      if (!action || ['cancelled', 'applied', 'failed'].includes(action.status)) return;
      await this.db.hrAction
        .update({ where: { id: hrActionId }, data: { status: 'failed', appliedAt: null, failReason: reason } })
        .catch(() => undefined);
      await this.notifyOutcome(action, 'hr.action.failed', { reason });
      this.logger.warn(`применение действия ${hrActionId}: ${reason}`);
      return;
    }

    if (!outcome) return; // уже применено/отменено — идемпотентный выход

    if (outcome.kind === 'failed') {
      await this.notifyOutcome(outcome.action, 'hr.action.failed', { reason: outcome.reason });
      await this.logMember(null, outcome.action.workspaceId, outcome.action.userId, 'hr.action_failed', {
        kindLabel: HR_ACTION_KIND_LABELS[outcome.action.kind as HrActionKind],
        reason: outcome.reason,
      });
      return;
    }

    // ---- После коммита: чужие сервисы и оповещения (best-effort) ----
    const { action, post } = outcome;
    if (post.syncFact) {
      await this.syncFactAssignment(
        action,
        post.syncFact.positionId,
        post.syncFact.branchId,
        post.syncFact.prevPositionId,
      );
    }
    if (post.removeMembership) {
      // Каскад системного увольнения не должен откатить юридический факт — при
      // ошибке кадровик снимает членство обычной кнопкой ростера.
      await this.workspaces
        .removeMember(action.createdById, action.workspaceId, action.userId)
        .catch((e) => this.logger.warn(`removeMember после увольнения ${action.userId}: ${(e as Error).message}`));
    }
    await this.notifyOutcome(action, 'hr.action.applied', {});
    const orderDocumentId = (action.params as { orderDocumentId?: string }).orderDocumentId;
    let documentSuffix = '';
    if (orderDocumentId) {
      const doc = await this.db.orgDocument.findUnique({
        where: { id: orderDocumentId },
        select: { number: true },
      });
      if (doc?.number) documentSuffix = ` (приказ ${doc.number})`;
    }
    await this.logMember(null, action.workspaceId, action.userId, 'hr.action_applied', {
      kindLabel: HR_ACTION_KIND_LABELS[action.kind as HrActionKind],
      documentSuffix,
    });
  }

  /**
   * Ст. 54 ТК РК: увольнение по инициативе работодателя запрещено в период
   * временной нетрудоспособности и отпуска — исключений ПЯТЬ (пп. 1), 18), 20),
   * 23) п. 1 ст. 52 и п. 1-1), не одна ликвидация. Отпуска проверяем ПО ДАННЫМ
   * СИСТЕМЫ (applied-действия kind=leave); БОЛЬНИЧНЫЕ СИСТЕМЕ НЕИЗВЕСТНЫ —
   * «проверьте вручную» стоит в модалке увольнения.
   */
  private async checkLegality(
    tx: HrTx,
    action: {
      id: string;
      workspaceId: string;
      userId: string;
      kind: string;
      effectiveAt: Date;
      params: unknown;
    },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (action.kind !== 'dismissal') return { ok: true };
    const params = (action.params ?? {}) as { ground?: string; banExceptionConfirmed?: boolean };
    if (!isEmployerInitiativeGround(params.ground)) return { ok: true };
    if (params.ground && ST54_BAN_EXCEPTION_GROUNDS.includes(params.ground)) return { ok: true };
    if (params.banExceptionConfirmed) return { ok: true };

    const effective = action.effectiveAt;
    const onLeave = await tx.hrAction.findFirst({
      where: {
        workspaceId: action.workspaceId,
        userId: action.userId,
        kind: 'leave',
        status: 'applied',
        effectiveAt: { lte: effective },
        effectiveTo: { gte: effective },
      },
      select: { id: true },
    });
    if (onLeave) {
      return {
        ok: false,
        reason:
          'ст. 54 ТК РК: увольнение по инициативе работодателя в период отпуска запрещено (по данным системы сотрудник в отпуске; исключения — пп. 1), 18), 20), 23) п. 1 ст. 52 и п. 1-1). Больничные системе неизвестны — проверяйте вручную',
      };
    }
    return { ok: true };
  }

  /**
   * Эффекты применения В ТРАНЗАКЦИИ: только собственные данные КЭДО (трудовая
   * карточка, очередь ЕСУТД). Работа с чужими сервисами возвращается наружу
   * описанием — её исполняет `applyAction` после коммита.
   */
  private async applyEffectsTx(tx: HrTx, action: HrActionRow): Promise<PostApplyEffects> {
    const params = (action.params ?? {}) as Record<string, unknown>;
    const post: PostApplyEffects = {};
    const employment = action.employmentId
      ? await tx.employment.findUnique({ where: { id: action.employmentId } })
      : await tx.employment.findFirst({
          where: { workspaceId: action.workspaceId, userId: action.userId, status: { not: 'terminated' } },
          orderBy: { createdAt: 'desc' },
        });
    if (!employment) throw new Error('трудовая карточка не найдена');

    const signedBase = await this.orderSignedDate(tx, action);

    switch (action.kind) {
      case 'hire': {
        await tx.employment.update({
          where: { id: employment.id },
          data: { status: 'active', hiredAt: action.effectiveAt },
        });
        // ЕСУТД: заключение — 5 РАБОЧИХ дней от подписания ОБЕИМИ сторонами
        await this.ensureEsutd(tx, action, 'contract', signedBase, employment.id);
        break;
      }
      case 'transfer': {
        const positionId = params.legalPositionId as string | undefined;
        if (!positionId) throw new Error('в параметрах перевода нет должности');
        const snapshots = await this.legalSnapshots(
          action.workspaceId,
          positionId,
          (params.legalBranchId as string) ?? null,
          tx,
        );
        const prevLegalPositionId = employment.legalPositionId;
        await tx.employment.update({
          where: { id: employment.id },
          data: {
            legalPositionId: positionId,
            legalPositionName: snapshots.positionName,
            legalBranchId: (params.legalBranchId as string) ?? null,
            legalBranchName: snapshots.branchName,
            ...(params.salaryAmount !== undefined ? { salaryAmount: BigInt(params.salaryAmount as number) } : {}),
          },
        });
        // Синхронизация ФАКТА — галочка «обновить фактическое назначение»: иначе
        // юридический перевод сам рождает расхождение факт/договор. Ходит в Staff,
        // поэтому исполняется после коммита.
        if (params.syncFact) {
          post.syncFact = {
            positionId,
            branchId: (params.legalBranchId as string) ?? null,
            prevPositionId: prevLegalPositionId,
          };
        }
        await this.ensureEsutd(tx, action, 'amendment', signedBase, employment.id);
        break;
      }
      case 'salary_change': {
        if (params.salaryAmount === undefined) throw new Error('в параметрах нет нового оклада');
        await tx.employment.update({
          where: { id: employment.id },
          data: { salaryAmount: BigInt(params.salaryAmount as number) },
        });
        await this.ensureEsutd(tx, action, 'amendment', signedBase, employment.id);
        break;
      }
      case 'leave':
        // Отпуск — только документооборот (решение грилла): отсутствие в календарь
        // не ставим, это придёт с Гантом. Applied-запись сама служит данным для
        // проверки ст. 54.
        break;
      case 'dismissal': {
        await tx.employment.update({
          where: { id: employment.id },
          data: {
            status: 'terminated',
            firedAt: action.effectiveAt,
            dismissalGround: (params.ground as string) ?? null,
          },
        });
        // ЕСУТД: прекращение — 3 РАБОЧИХ дня ОТ ДНЯ ПРЕКРАЩЕНИЯ
        await this.ensureEsutd(tx, action, 'termination', dateStr(action.effectiveAt)!, employment.id);
        // «И то и другое»: юридическое увольнение снимает и членство в системе —
        // после коммита (removeMember ведёт свои транзакции и каскады).
        if (params.alsoRemoveMembership) post.removeMembership = true;
        break;
      }
    }
    return post;
  }

  /** Дата подписания приказа (база сроков ЕСУТД contract/amendment); нет — сегодня */
  private async orderSignedDate(tx: HrTx, action: { params: unknown }): Promise<string> {
    const orderDocumentId = (action.params as { orderDocumentId?: string }).orderDocumentId;
    if (orderDocumentId) {
      const doc = await tx.orgDocument.findUnique({
        where: { id: orderDocumentId },
        select: { signedAt: true },
      });
      if (doc?.signedAt) return dateStr(doc.signedAt)!;
    }
    return this.calendar.today();
  }

  private async ensureEsutd(
    tx: HrTx,
    action: { id: string; workspaceId: string; userId: string },
    kind: 'contract' | 'amendment' | 'termination',
    baseDate: string,
    employmentId: string,
  ): Promise<void> {
    // Ленивое ребро в HrService не заводим — очередь пишется прямо здесь тем же
    // правилом, что HrService.ensureEsutdSubmission (одна живая на действие+вид).
    const existing = await tx.esutdSubmission.findFirst({
      where: { workspaceId: action.workspaceId, hrActionId: action.id, kind, status: 'pending' },
      select: { id: true },
    });
    if (existing) return;
    // Единая точка правды сроков — HR_DEADLINE_RULE_MAP (та же, что у
    // HrService.ensureEsutdSubmission): вторая рукописная копия правила уже
    // однажды разъехалась бы с законом молча.
    const rule = HR_DEADLINE_RULE_MAP[ESUTD_KINDS.find((k) => k.value === kind)!.ruleKey];
    let dueAt: string;
    try {
      dueAt =
        rule.unit === 'work_days'
          ? await this.calendar.addWorkDays(baseDate, rule.amount)
          : this.calendar.addCalendarDays(baseDate, rule.amount);
    } catch {
      // За горизонтом календаря — календарный счёт: он даёт срок РАНЬШЕ
      // настоящего (рабочие дни длиннее календарных), то есть ошибается в
      // безопасную сторону; строка в очереди важнее точности, экран пересчитает.
      dueAt = this.calendar.addCalendarDays(baseDate, rule.amount);
    }
    await tx.esutdSubmission.create({
      data: {
        workspaceId: action.workspaceId,
        userId: action.userId,
        kind,
        hrActionId: action.id,
        employmentId,
        dueAt: new Date(dueAt),
        payload: {},
      },
    });
  }

  /** Факт вслед за договором: снять назначение старой договорной должности, поставить новую */
  private async syncFactAssignment(
    action: { workspaceId: string; userId: string; createdById: string },
    positionId: string,
    branchId: string | null,
    prevLegalPositionId: string | null,
  ): Promise<void> {
    try {
      if (prevLegalPositionId && prevLegalPositionId !== positionId) {
        const old = await this.db.staffAssignment.findFirst({
          where: { workspaceId: action.workspaceId, userId: action.userId, positionId: prevLegalPositionId },
          select: { id: true },
        });
        if (old) await this.staff.removeAssignment(action.createdById, action.workspaceId, old.id);
      }
      const exists = await this.db.staffAssignment.findFirst({
        where: { workspaceId: action.workspaceId, userId: action.userId, positionId, branchId: branchId ?? null },
        select: { id: true },
      });
      if (!exists) {
        await this.staff.assignPosition(action.createdById, action.workspaceId, action.userId, {
          positionId,
          branchId,
          status: 'certified',
        });
      }
    } catch (e) {
      // Синхронизация факта best-effort: расхождение покажет плашка, а не сломанное применение
      this.logger.warn(`syncFact ${action.userId}: ${(e as Error).message}`);
    }
  }

  private async notifyOutcome(
    action: { id: string; workspaceId: string; userId: string; kind: string; effectiveAt: Date; createdById: string },
    type: 'hr.action.applied' | 'hr.action.failed',
    extra: Record<string, unknown>,
  ): Promise<void> {
    const payload = {
      kindLabel: HR_ACTION_KIND_LABELS[action.kind as HrActionKind],
      targetName: await this.nameOf(action.userId),
      effectiveAt: dateStr(action.effectiveAt),
      workspaceId: action.workspaceId,
      hrActionId: action.id,
      ...extra,
    };
    const actionUrl = hrMemberHref(action.workspaceId, action.userId);
    const recipients = new Set([action.createdById, ...(type === 'hr.action.applied' ? [action.userId] : [])]);
    for (const uid of recipients) {
      await this.notifications
        .notify(uid, type, payload, { actionUrl, dedupKey: `${type}:${action.id}:${uid}` })
        .catch(() => undefined);
    }
  }

  // ============================================================
  // Отмена (в т.ч. отзыв заявления работником — ст. 56 п. 4)
  // ============================================================

  async cancelAction(actorId: string, workspaceId: string, actionId: string): Promise<HrActionDto> {
    const action = await this.db.hrAction.findFirst({ where: { id: actionId, workspaceId } });
    if (!action) throw new NotFoundException('Кадровое действие не найдено');

    const role = await this.roleOf(actorId, workspaceId);
    /**
     * Ст. 56 п. 4 даёт безусловный отзыв ЗАЯВЛЕНИЮ РАБОТНИКА — увольнению по его
     * собственной инициативе. К приказу работодателя (сокращение, ст. 52,
     * соглашение сторон) это право не относится вовсе: пока проверялся только
     * «kind === dismissal и это про меня», работник, узнав о сокращении, отменял
     * приказ сам — и так сколько угодно раз (проверено зондом ревью).
     */
    const dismissalGround = (action.params as { ground?: string }).ground;
    const isOwnApplication =
      action.kind === 'dismissal' &&
      action.userId === actorId &&
      (action.source === 'employee' || dismissalGround === 'st56');
    if (!this.isManager(role) && !isOwnApplication) {
      if (action.userId === actorId && action.kind === 'dismissal') {
        throw coded(
          'Это приказ работодателя, а не ваше заявление: отзыв по ст. 56 п. 4 ТК РК относится только к увольнению по собственному желанию',
          HR_ERROR_CODES.withdrawNotOwnApplication,
        );
      }
      throw new ForbiddenException('Отменить действие может Менеджер+ (или сам работник — своё заявление об увольнении)');
    }
    if (this.isManager(role)) {
      const subjectRole = await this.roleOf(action.userId, workspaceId);
      if (subjectRole) assertCanManageHrSubject(role!, subjectRole);
    }
    // Ст. 56 п. 4: отзыв заявления работником БЕЗУСЛОВЕН весь срок уведомления —
    // то есть до применения. Для менеджера правило то же: применённое не отменяется
    // (его разворачивает встречное действие).
    const claimed = await this.db.hrAction.updateMany({
      where: { id: action.id, status: { in: ['draft', 'in_progress', 'scheduled'] } },
      data: { status: 'cancelled' },
    });
    if (claimed.count === 0) {
      throw coded('Действие уже применено или закрыто — отменить нечего', HR_ERROR_CODES.actionNotActive);
    }
    // Отложенный джоб применения отменяем (невзятый); executing добьёт статус-гвард
    await this.jobs.cancelByUniqueKey(null, HR_APPLY_JOB, `hrapply:${action.id}`).catch(() => undefined);

    // Неприменённый приказ отменяется; ИЗДАННЫЙ (подписан/зарегистрирован) —
    // кадровику НАСТОЯЩАЯ задача Задачника «издать приказ об отмене» (v1 —
    // полуручной путь: срок, напоминания и приёмка у задачи уже есть).
    const issued = await this.documents.systemCancelForHrAction(action.id, actorId);
    if (issued.issuedLeft > 0) {
      const kindLabel = HR_ACTION_KIND_LABELS[action.kind as HrActionKind];
      const targetName = await this.nameOf(action.userId);
      await this.tasks
        .createTask(
          actorId,
          {
            title: `Издать приказ об отмене: ${kindLabel} — ${targetName}`,
            description:
              `Действие «${kindLabel}» отменено${isOwnApplication ? ' отзывом заявления (ст. 56 п. 4 ТК РК)' : ''}, ` +
              `но приказ уже издан (подписан/зарегистрирован) — изданное отменяется только встречным приказом. ` +
              `Карточка сотрудника: ${hrMemberHref(workspaceId, action.userId)}`,
            executorId: action.createdById,
            workspaceId,
          } as Parameters<TasksService['createTask']>[1],
          // Членство обеих сторон уже проверено гейтами КЭДО; окружение не при чём
          { skipEnvironmentChecks: true, origin: 'hr' },
        )
        .catch((e) => this.logger.warn(`задача «приказ об отмене» ${action.id}: ${(e as Error).message}`));
    }

    if (isOwnApplication && !this.isManager(role)) {
      await this.notifications
        .notify(
          action.createdById,
          'hr.action.withdrawn',
          {
            targetName: await this.nameOf(action.userId),
            note: issued.issuedLeft > 0 ? 'Приказ уже издан — издайте приказ об отмене.' : '',
            workspaceId,
          },
          { actionUrl: hrMemberHref(workspaceId, action.userId), dedupKey: `hrwd:${action.id}` },
        )
        .catch(() => undefined);
    }
    await this.logMember(actorId, workspaceId, action.userId, 'hr.action_cancelled', {
      kindLabel: HR_ACTION_KIND_LABELS[action.kind as HrActionKind],
      noteSuffix: isOwnApplication && !this.isManager(role) ? ' (отзыв заявления, ст. 56 п. 4 ТК РК)' : '',
    });
    return this.getAction(workspaceId, action.id);
  }

  // ============================================================
  // Массовые действия
  // ============================================================

  async createBatch(actorId: string, workspaceId: string, dto: CreateHrBatchInput): Promise<HrActionBatchDto> {
    const actorRole = await this.requireManager(actorId, workspaceId);
    await this.assertApplyRoute(workspaceId, dto.templateId);
    const userIds = await this.resolveAudience(workspaceId, dto.audience, actorRole);
    if (userIds.length === 0) throw new BadRequestException('Аудитория пуста — некому применять');
    if (userIds.length > HR_LIMITS.batchMax) {
      throw new BadRequestException(`Потолок массовой операции — ${HR_LIMITS.batchMax} человек за прогон (выбрано ${userIds.length})`);
    }
    const batch = await this.db.$transaction(async (tx) => {
      const row = await tx.hrActionBatch.create({
        data: {
          workspaceId,
          kind: dto.kind,
          params: {
            ...(dto.params ?? {}),
            templateId: dto.templateId,
            effectiveAt: dto.effectiveAt,
            effectiveTo: dto.effectiveTo ?? null,
            fields: dto.fields ?? {},
            userIds,
          } as object,
          audience: dto.audience as object[],
          total: userIds.length,
          createdById: actorId,
        },
      });
      await this.jobs.enqueue(tx, {
        type: HR_BATCH_JOB,
        payload: { batchId: row.id },
        uniqueKey: `hrbatch:${row.id}`,
      });
      return row;
    });
    return this.getBatch(actorId, workspaceId, batch.id);
  }

  /** Исполнение пачки (джоб, идемпотентно: пропускает уже созданные действия) */
  async runBatch(batchId: string): Promise<void> {
    const batch = await this.db.hrActionBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.status !== 'running') return;
    const p = batch.params as {
      templateId: string;
      effectiveAt: string;
      effectiveTo: string | null;
      fields: Record<string, unknown>;
      userIds: string[];
    } & Record<string, unknown>;
    const { templateId, effectiveAt, effectiveTo, fields, userIds, ...actionParams } = p;
    for (const userId of userIds ?? []) {
      const exists = await this.db.hrAction.findFirst({
        where: { batchId: batch.id, userId },
        select: { id: true },
      });
      if (exists) continue;
      try {
        const dto: CreateHrActionInput = {
          kind: batch.kind,
          userId,
          effectiveAt,
          ...(effectiveTo ? { effectiveTo } : {}),
          templateId,
          params: actionParams as CreateHrActionInput['params'],
          fields,
        };
        // batchId проставляется В САМОМ создании: дописанный вторым запросом, он
        // терялся при обрыве джоба между ними, и ретрай (аренда, деплой) заводил
        // человеку ВТОРОЕ действие с полным комплектом документов.
        await this.createAction(batch.createdById, batch.workspaceId, dto, { batchId: batch.id });
      } catch (e) {
        // Один неподходящий человек (нет карточки, уже уволен) не валит пачку:
        // след — failed-действие с причиной, его видно на экране прогресса.
        await this.db.hrAction
          .create({
            data: {
              workspaceId: batch.workspaceId,
              userId,
              kind: batch.kind,
              status: 'failed',
              source: 'employer',
              effectiveAt: new Date(effectiveAt),
              effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
              params: actionParams as object,
              batchId: batch.id,
              failReason: (e as Error).message,
              createdById: batch.createdById,
            },
          })
          .catch(() => undefined);
      }
    }
    await this.db.hrActionBatch.update({ where: { id: batch.id }, data: { status: 'done' } });
  }

  private async resolveAudience(
    workspaceId: string,
    audience: { type: string; id: string }[],
    actorRole?: WorkspaceRole,
  ): Promise<string[]> {
    const out = new Set<string>();
    for (const principal of audience) {
      if (principal.type === 'user') {
        out.add(principal.id);
        continue;
      }
      if (principal.type === 'workspace') {
        const members = await this.db.userRole.findMany({
          where: {
            context: WS_CONTEXT,
            tenantId: workspaceId,
            isActive: true,
            role: { notIn: ['contractor'] },
          },
          select: { userId: true },
        });
        members.forEach((m) => out.add(m.userId));
        continue;
      }
      const rows = await this.db.relationTuple.findMany({
        where: {
          resourceType: principal.type,
          resourceId: principal.id,
          relation: principal.type === 'position' ? 'holder' : 'member',
          subjectType: 'user',
          subjectRelation: '',
        },
        select: { subjectId: true },
        take: HR_LIMITS.campaignMaxTargets,
      });
      rows.forEach((r) => out.add(r.subjectId));
    }
    // Команда организации, живые роли (подрядчики исключены)
    const ids = [...out];
    if (!ids.length) return [];
    const live = await this.db.userRole.findMany({
      where: {
        userId: { in: ids },
        context: WS_CONTEXT,
        tenantId: workspaceId,
        isActive: true,
        role: { notIn: ['contractor'] },
      },
      select: { userId: true, role: true },
    });
    // Ранг: массовое действие на «всю организацию» не должно оформлять увольнение
    // Владельцу руками Менеджера. Тихо отсеиваем (а не отказываем всей пачке) —
    // иначе аудитория «вся команда» была бы недоступна никому, кроме Владельца.
    const manageable = actorRole
      ? live.filter((r) => canManageHrSubject(actorRole, r.role as WorkspaceRole))
      : live;
    const alive = new Set(manageable.map((r) => r.userId));
    return ids.filter((id) => alive.has(id));
  }

  async getBatch(viewerId: string, workspaceId: string, batchId: string): Promise<HrActionBatchDto> {
    await this.requireManager(viewerId, workspaceId);
    const batch = await this.db.hrActionBatch.findFirst({ where: { id: batchId, workspaceId } });
    if (!batch) throw new NotFoundException('Массовая операция не найдена');
    const groups = await this.db.hrAction.groupBy({
      by: ['status'],
      where: { batchId: batch.id },
      _count: true,
    });
    const progress = { draft: 0, in_progress: 0, scheduled: 0, applied: 0, cancelled: 0, failed: 0 } as Record<
      HrActionStatus,
      number
    >;
    for (const g of groups) progress[g.status as HrActionStatus] = g._count;
    return {
      id: batch.id,
      workspaceId: batch.workspaceId,
      kind: batch.kind as HrActionKind,
      params: (batch.params ?? {}) as Record<string, unknown>,
      total: batch.total,
      status: batch.status as HrActionBatchDto['status'],
      createdById: batch.createdById,
      createdAt: batch.createdAt.toISOString(),
      progress,
    };
  }

  // ============================================================
  // Чтение
  // ============================================================

  async getAction(workspaceId: string, actionId: string): Promise<HrActionDto> {
    const row = await this.db.hrAction.findFirst({ where: { id: actionId, workspaceId } });
    if (!row) throw new NotFoundException('Кадровое действие не найдено');
    return (await this.serializeMany([row]))[0];
  }

  /**
   * Действия человека. `includeDrafts` — ТОЛЬКО для Менеджера+: черновик приказа
   * (вид, основание увольнения, дата, новый оклад) — это внутренняя подготовка
   * работодателя. Ровно это правило уже стоит на документах («сторона видит с
   * момента отправки ей»), и оно обязано действовать на обоих путях: до починки
   * работник открывал свою карточку и читал готовящееся сокращение (проверено
   * зондом ревью).
   */
  async listForUser(
    workspaceId: string,
    userId: string,
    limit = 20,
    opts: { includeDrafts?: boolean } = {},
  ): Promise<HrActionDto[]> {
    const rows = await this.db.hrAction.findMany({
      where: { workspaceId, userId, ...(opts.includeDrafts ? {} : { status: { not: 'draft' } }) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return this.serializeMany(rows);
  }

  /** Мои действия-заявления (работник видит свои: отзыв по ст. 56 п. 4) */
  async listMine(viewerId: string, workspaceId: string): Promise<HrActionDto[]> {
    const role = await this.roleOf(viewerId, workspaceId);
    if (!role || role === 'contractor') throw new ForbiddenException('Нет доступа к этой организации');
    return this.listForUser(workspaceId, viewerId, 50, { includeDrafts: this.isManager(role) });
  }

  private async serializeMany(
    rows: {
      id: string;
      workspaceId: string;
      userId: string;
      kind: string;
      status: string;
      source: string;
      effectiveAt: Date;
      effectiveTo: Date | null;
      params: unknown;
      batchId: string | null;
      employmentId: string | null;
      appliedAt: Date | null;
      failReason: string | null;
      createdById: string;
      createdAt: Date;
    }[],
  ): Promise<HrActionDto[]> {
    if (!rows.length) return [];
    const docs = await this.db.orgDocument.findMany({
      where: { hrActionId: { in: rows.map((r) => r.id) } },
      select: {
        id: true,
        hrActionId: true,
        title: true,
        number: true,
        status: true,
        template: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const docsByAction = new Map<string, typeof docs>();
    for (const d of docs) {
      const list = docsByAction.get(d.hrActionId!) ?? [];
      list.push(d);
      docsByAction.set(d.hrActionId!, list);
    }
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      kind: row.kind as HrActionKind,
      status: row.status as HrActionStatus,
      source: row.source as HrActionDto['source'],
      effectiveAt: dateStr(row.effectiveAt)!,
      effectiveTo: dateStr(row.effectiveTo),
      params: (row.params ?? {}) as Record<string, unknown>,
      batchId: row.batchId,
      employmentId: row.employmentId,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      failReason: row.failReason,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      documents: (docsByAction.get(row.id) ?? []).map((d) => ({
        id: d.id,
        title: d.title,
        number: d.number,
        status: d.status as HrActionDto['documents'][number]['status'],
        templateName: d.template?.name ?? null,
      })),
    }));
  }
}
