import { Injectable, Logger } from '@nestjs/common';
import {
  CAMPAIGN_AUDIENCE_KINDS,
  ESUTD_KINDS,
  HR_DEADLINE_RULE_MAP,
  HR_ERROR_CODES,
  HR_LIMITS,
  ST54_BAN_EXCEPTION_GROUNDS,
  WORKSPACE_ROLE_RANK,
  isEmployerInitiativeGround,
  hrMemberHref,
  type AudienceRef,
  type CreateHrActionInput,
  type CreateHrBatchInput,
  type HrActionBatchDto,
  type HrActionDto,
  type HrActionKind,
  type HrActionStatus,
  type WorkspaceRole,
} from '@superapp/shared';
import { SOURCE_LOCALE } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, forbidden, notFound } from '../../shared/errors/api-error';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../../core/notifications/notifications.service';
import { DocumentsService } from '../documents/documents.service';
import { StaffService } from '../staff/staff.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { LegalEntitiesService } from '../workspaces/legal-entities.service';
import { KeysCascadesService } from '../../core/keys/api-keys/keys.cascades.service';
import { assignmentToday } from '../../shared/utils/assignment-window';
import { HrCalendarService } from './hr-calendar.service';
import { AudiencesService } from '../../core/audiences/audiences.service';
import {
  HR_APPLY_JOB,
  HR_BATCH_JOB,
  HR_MEMBER_REF_TYPE,
  assertCanManageHrSubject,
  canManageHrSubject,
  hrMemberRefId,
} from './hr.constants';
import { fullName } from '../../shared/utils/user-name';
import { VisibilityService } from '../../core/visibility/visibility.service';

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
  /** Хвост каскада ключей после коммита (сокет `keys:changed` владельцу и админам) */
  keysAfter?: () => Promise<void>;
  /**
   * Увольнение ЗАКРЫВАЕТ фактические назначения датой приказа (а не стирает их):
   * история, ставки и смены остаются, права снимаются фильтром по датам.
   */
  closeAssignments?: string;
  /** Приём с syncFact: создать фактическое назначение с даты приказа */
  hireFact?: { positionId: string; branchId: string | null; startsOn: string };
}

const dateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Сегодня в поясе платформы (фолбэк, если у действия нет даты вступления) */
const orgTodayIso = (): string => assignmentToday();

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

  /** Слово в языке ИСТОЧНИКА — снимок, который ложится в БД навсегда */
  private src(key: string, values?: Record<string, string | number>): string {
    return this.i18n.translateFor(SOURCE_LOCALE, key, values);
  }

  /**
   * Причина отказа для витрины: в колонке новых записей лежит КЛЮЧ каталога — его
   * переводим в языке запроса; у записей до перехода там готовая фраза (и техническое
   * сообщение сбоя тоже) — она показывается как есть.
   */
  private reasonText(value: string | null): string | null {
    if (!value) return null;
    return this.i18n.has(value) ? this.i18n.translate(value) : value;
  }

  constructor(
    private readonly db: DatabaseService,
    private readonly i18n: I18nService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly documents: DocumentsService,
    private readonly staff: StaffService,
    private readonly tasks: TasksService,
    private readonly workspaces: WorkspacesService,
    private readonly calendar: HrCalendarService,
    private readonly audiences: AudiencesService,
    private readonly legal: LegalEntitiesService,
    private readonly keysCascades: KeysCascadesService,
    private readonly visibility: VisibilityService,
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
    if (!role || role === 'contractor') throw forbidden('workspace.noAccess');
    if (!this.isManager(role)) throw forbidden('hr.actionsManagerOnly');
    return role;
  }

  /** Имя в payload: данные под своим именем либо слово ключом */
  private namePayload(name: string | null): Record<string, string> {
    return name ? { targetName: name } : { targetNameKey: 'common.labels.someone' };
  }

  /**
   * Имя для ВЕЧНОЙ записи: снимок ИЛИ null. Слово вместо пропавшего имени кладут
   * ключом (`<имя>Key`) — фраза застыла бы в языке того, кто нажал кнопку.
   */
  private async nameOf(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? fullName(u) : null;
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
        actorName: actorId ? await this.nameOf(actorId) : null,
        typeKey,
        // Действие без человека — это СИСТЕМА, и слово для неё едет ключом:
        // записанное фразой, оно застыло бы в языке источника (docs/i18n.md).
        payload: actorId ? payload : { ...payload, actorNameKey: 'common.labels.system' },
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
      throw badRequest('hr.actionMemberOnly');
    }
    assertCanManageHrSubject(actorRole, subjectRole);
    const kind = dto.kind as HrActionKind;
    const params = dto.params ?? {};

    // Обязательное по виду — проверяем ЗДЕСЬ, а не в Zod: параметры дополняют
    // друг друга, и только сервис знает, что для какого вида несущее.
    if (kind === 'leave' && !dto.effectiveTo) throw badRequest('hr.leaveEndRequired');
    if (kind === 'dismissal' && !params.ground) throw badRequest('hr.groundRequired');
    // «Снять и членство» — то же право, что у кнопки ростера. Проверка при СОЗДАНИИ приказа:
    // применение снимает членство от имени автора, и галочка без права молча не сработала бы
    if (kind === 'dismissal' && params.alsoRemoveMembership) {
      await this.workspaces.assertCanRemoveMember(actorId, workspaceId, dto.userId);
    }
    if (kind === 'transfer' && !params.legalPositionId) throw badRequest('hr.positionRequired');
    if (kind === 'salary_change' && params.salaryAmount === undefined) throw badRequest('hr.salaryRequired');
    // Оклад и основание в приказе — поля трудовой карточки (`hr.employment`): нельзя задать
    // то, чего не видишь (W) — Менеджер без права на оклад не проведёт и «изменение оклада»
    if (params.salaryAmount !== undefined || params.ground !== undefined) {
      const live = await this.db.employment.findFirst({
        where: { workspaceId, userId: dto.userId, status: { not: 'terminated' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, legalBranchId: true },
      });
      await this.visibility.assertWritable(
        this.visibility.viewer('api', { workspaceId }),
        'hr.employment',
        {
          recordId: live?.id ?? dto.userId,
          subjectId: dto.userId,
          workspaceId,
          stage: live?.status ?? 'draft',
          branchId: params.legalBranchId ?? live?.legalBranchId ?? null,
        },
        { salaryAmount: params.salaryAmount, dismissalGround: params.ground },
      );
    }

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
        throw badRequest(
          kind === 'dismissal' ? 'hr.dismissalDuplicate' : 'hr.actionDuplicate',
          { kind: this.i18n.translate(`hr.actionKind.${kind}`) },
          { code: HR_ERROR_CODES.actionDuplicate },
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
    // Работодатель по действию: явная карточка (совместительство) → её юрлицо;
    // иначе указанное в параметрах; иначе головное. Живая карточка ищется В ЭТОМ
    // юрлице — вторая карточка в другом ТОО не мешает приёму.
    let employmentId: string | null = null;
    const explicit = dto.employmentId
      ? await this.db.employment.findFirst({
          where: { id: dto.employmentId, workspaceId, userId: dto.userId },
        })
      : null;
    if (dto.employmentId && !explicit) throw badRequest('hr.employmentNotFound');
    const legalEntityId = explicit
      ? explicit.legalEntityId
      : await this.legal.resolveLegalEntityId(workspaceId, params.legalEntityId ?? null);
    const legalEntity = await this.db.legalEntity.findUnique({
      where: { id: legalEntityId },
      select: { name: true },
    });
    const live =
      explicit ??
      (await this.db.employment.findFirst({
        where: { workspaceId, userId: dto.userId, legalEntityId, status: { not: 'terminated' } },
        orderBy: { createdAt: 'desc' },
      }));
    if (kind === 'hire') {
      if (live && live.status === 'active') {
        throw badRequest('hr.employmentAlreadyLive');
      }
      const snapshots = params.legalPositionId
        ? await this.legalSnapshots(workspaceId, params.legalPositionId, params.legalBranchId ?? null)
        : { positionName: null, branchName: null };
      const draft =
        live ??
        (await this.db.employment.create({
          data: {
            workspaceId,
            userId: dto.userId,
            legalEntityId,
            legalEntityName: legalEntity?.name ?? null,
            status: 'draft',
            createdById: actorId,
          },
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
      if (!live) throw badRequest('hr.employmentRequired');
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
      kindLabelKey: `hr.actionKind.${kind}`,
      ...(docIds.length ? { documentSuffixKey: 'hr.documentCountSuffix', docCount: docIds.length } : {}),
    });

    return this.getAction(workspaceId, action.id);
  }

  private async legalSnapshots(workspaceId: string, positionId: string, branchId: string | null, tx?: HrTx) {
    const db = tx ?? this.db;
    const pos = await db.staffPosition.findFirst({ where: { id: positionId, workspaceId }, select: { name: true } });
    if (!pos) throw badRequest('hr.positionNotFound');
    let branchName: string | null = null;
    if (branchId) {
      const br = await db.staffBranch.findFirst({ where: { id: branchId, workspaceId }, select: { name: true } });
      if (!br) throw badRequest('hr.branchNotFound');
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
      throw badRequest('hr.noRoute', undefined, { code: HR_ERROR_CODES.noApplyRoute });
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
      throw badRequest('hr.noApplyNode', undefined, { code: HR_ERROR_CODES.noApplyRoute });
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
    if (!action) throw notFound('hr.actionNotFound');
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
      | { kind: 'failed'; action: HrActionRow; reasonKey: string }
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
          const reasonKey = legality.reasonKey ?? 'hr.fail.legality';
          // `failReason` — колонка БД: в ней лежит КЛЮЧ каталога, а слово собирается
          // при чтении в языке зрителя. Записанная фраза застыла бы английской у
          // казахоязычного кадровика (docs/i18n.md).
          await tx.hrAction.update({
            where: { id: action.id },
            data: { status: 'failed', appliedAt: null, failReason: reasonKey },
          });
          return { kind: 'failed' as const, action, reasonKey };
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
      this.logger.warn(`applying hr action ${hrActionId}: ${reason}`);
      return;
    }

    if (!outcome) return; // уже применено/отменено — идемпотентный выход

    if (outcome.kind === 'failed') {
      await this.notifyOutcome(outcome.action, 'hr.action.failed', { reasonKey: outcome.reasonKey });
      await this.logMember(null, outcome.action.workspaceId, outcome.action.userId, 'hr.action_failed', {
        kindLabelKey: `hr.actionKind.${outcome.action.kind}`,
        reasonKey: outcome.reasonKey,
      });
      return;
    }

    // ---- После коммита: чужие сервисы и оповещения (best-effort) ----
    const { action, post } = outcome;
    if (post.closeAssignments) {
      // `system*`: право проверено при создании приказа (контракт движка).
      await this.staff
        .closeAssignmentsSystem(action.workspaceId, action.userId, post.closeAssignments)
        .catch((e) =>
          this.logger.warn(`closeAssignments after dismissal of ${action.userId}: ${(e as Error).message}`),
        );
    }
    if (post.hireFact) {
      await this.hireFactAssignment(action, post.hireFact);
    }
    if (post.syncFact) {
      await this.syncFactAssignment(
        action,
        post.syncFact.positionId,
        post.syncFact.branchId,
        post.syncFact.prevPositionId,
      );
    }
    if (post.keysAfter) {
      await post.keysAfter().catch((e) => this.logger.warn(`keys cascade after dismissal of ${action.userId}: ${(e as Error).message}`));
    }
    if (post.removeMembership) {
      // Каскад системного увольнения не должен откатить юридический факт — при
      // ошибке кадровик снимает членство обычной кнопкой ростера (снятие атомарно,
      // повтор проходит). В журнале исполнитель — система, инициатор — автор действия.
      await this.workspaces
        .removeMember(action.createdById, action.workspaceId, action.userId, { hrActionId: action.id })
        .catch((e) => this.logger.warn(`removeMember after dismissal of ${action.userId}: ${(e as Error).message}`));
    }
    await this.notifyOutcome(action, 'hr.action.applied', {});
    const orderDocumentId = (action.params as { orderDocumentId?: string }).orderDocumentId;
    let orderNumber: string | null = null;
    if (orderDocumentId) {
      const doc = await this.db.orgDocument.findUnique({
        where: { id: orderDocumentId },
        select: { number: true },
      });
      orderNumber = doc?.number ?? null;
    }
    await this.logMember(null, action.workspaceId, action.userId, 'hr.action_applied', {
      kindLabelKey: `hr.actionKind.${action.kind}`,
      ...(orderNumber ? { documentSuffixKey: 'hr.orderNumberSuffix', number: orderNumber } : {}),
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
  ): Promise<{ ok: boolean; reasonKey?: string }> {
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
    if (onLeave) return { ok: false, reasonKey: 'hr.fail.st54Leave' };
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
    if (!employment) throw new Error('the employment record is not found');

    const signedBase = await this.orderSignedDate(tx, action);

    switch (action.kind) {
      case 'hire': {
        await tx.employment.update({
          where: { id: employment.id },
          data: { status: 'active', hiredAt: action.effectiveAt },
        });
        // Приём с галочкой «обновить факт» заводит НАЗНАЧЕНИЕ с даты приказа:
        // раньше приём факт не создавал вовсе, и человек оставался вне объекта.
        if (params.syncFact && employment.legalPositionId) {
          post.hireFact = {
            positionId: employment.legalPositionId,
            branchId: employment.legalBranchId ?? null,
            startsOn: dateStr(action.effectiveAt)!,
          };
        }
        // ЕСУТД: заключение — 5 РАБОЧИХ дней от подписания ОБЕИМИ сторонами
        await this.ensureEsutd(tx, action, 'contract', signedBase, employment.id);
        break;
      }
      case 'transfer': {
        const positionId = params.legalPositionId as string | undefined;
        if (!positionId) throw new Error('the transfer parameters carry no position');
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
        if (params.salaryAmount === undefined) throw new Error('the parameters carry no new salary');
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
        // Ключи (core/keys, правило «на всех путях ухода»): личные ключи уволенного для данных
        // организации гаснут В ЭТОЙ ЖЕ транзакции, его боты замораживаются до решения владельца —
        // независимо от того, снимается ли членство в системе (человек мог остаться подрядчиком).
        post.keysAfter = await this.keysCascades.onMemberLeft(tx, action.workspaceId, action.userId, 'dismissed', action.createdById);
        // Факт закрывается ДАТОЙ ПРИКАЗА: назначения остаются в истории (на них
        // ссылаются ставки и смены), но перестают действовать и давать права.
        post.closeAssignments = dateStr(action.effectiveAt)!;
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
    action: { workspaceId: string; userId: string; createdById: string; effectiveAt?: Date },
    positionId: string,
    branchId: string | null,
    prevLegalPositionId: string | null,
  ): Promise<void> {
    const effectiveAt = dateStr((action as { effectiveAt?: Date }).effectiveAt ?? null) ?? orgTodayIso();
    try {
      // СНАЧАЛА закрываем старое (иначе EXCLUDE-ограничение по периодам отвергнет
      // новое назначение той же связки), и только потом создаём новое.
      if (prevLegalPositionId && prevLegalPositionId !== positionId) {
        const prevDay = new Date(new Date(`${effectiveAt}T00:00:00.000Z`).getTime() - 86_400_000)
          .toISOString()
          .slice(0, 10);
        const closed = await this.staff.closeAssignmentsSystem(
          action.workspaceId,
          action.userId,
          prevDay,
        );
        if (closed === 0) {
          this.logger.warn(`syncFact ${action.userId}: no previous assignment found — fact/contract mismatch`);
        }
      }
      // Без объекта назначения не бывает: договор без объекта → основной объект.
      const targetBranchId = branchId ?? (await this.staff.ensureDefaultBranch(action.workspaceId)).id;
      const exists = await this.db.staffAssignment.findFirst({
        where: {
          workspaceId: action.workspaceId,
          userId: action.userId,
          positionId,
          branchId: targetBranchId,
          OR: [{ endsOn: null }, { endsOn: { gte: new Date(`${effectiveAt}T00:00:00.000Z`) } }],
        },
        select: { id: true },
      });
      if (!exists) {
        await this.staff.assignPositionSystem(action.createdById, action.workspaceId, action.userId, {
          positionId,
          branchId: targetBranchId,
          status: 'certified',
          startsOn: effectiveAt,
        });
      }
    } catch (e) {
      // Синхронизация факта best-effort: расхождение покажет плашка, а не сломанное
      // применение. Но МОЛЧА глотать нельзя — пишем в хронику человека.
      this.logger.warn(`syncFact ${action.userId}: ${(e as Error).message}`);
      await this.logMember(null, action.workspaceId, action.userId, 'hr.action_failed', {
        kindLabelKey: 'hr.factSync',
        reason: (e as Error).message,
      }).catch(() => undefined);
    }
  }

  /** Приём с syncFact: фактическое назначение с даты приказа (`system*`). */
  private async hireFactAssignment(
    action: { workspaceId: string; userId: string; createdById: string },
    fact: { positionId: string; branchId: string | null; startsOn: string },
  ): Promise<void> {
    try {
      const targetBranchId = fact.branchId ?? (await this.staff.ensureDefaultBranch(action.workspaceId)).id;
      const exists = await this.db.staffAssignment.findFirst({
        where: {
          workspaceId: action.workspaceId,
          userId: action.userId,
          positionId: fact.positionId,
          branchId: targetBranchId,
          OR: [{ endsOn: null }, { endsOn: { gte: new Date(`${fact.startsOn}T00:00:00.000Z`) } }],
        },
        select: { id: true },
      });
      if (exists) return;
      await this.staff.assignPositionSystem(action.createdById, action.workspaceId, action.userId, {
        positionId: fact.positionId,
        branchId: targetBranchId,
        startsOn: fact.startsOn,
      });
    } catch (e) {
      this.logger.warn(`hireFact ${action.userId}: ${(e as Error).message}`);
    }
  }

  private async notifyOutcome(
    action: { id: string; workspaceId: string; userId: string; kind: string; effectiveAt: Date; createdById: string },
    type: 'hr.action.applied' | 'hr.action.failed',
    extra: Record<string, unknown>,
  ): Promise<void> {
    const targetName = await this.nameOf(action.userId);
    const payload = {
      kindLabelKey: `hr.actionKind.${action.kind}`,
      // Имя — данные; его отсутствие — слово продукта, и оно едет ключом.
      ...(targetName ? { targetName } : { targetNameKey: 'common.labels.someone' }),
      effectiveAt: dateStr(action.effectiveAt),
      workspaceId: action.workspaceId,
      hrActionId: action.id,
      ...extra,
    };
    const actionUrl = hrMemberHref(action.workspaceId, action.userId);
    const recipients = new Set([action.createdById, ...(type === 'hr.action.applied' ? [action.userId] : [])]);
    await this.notifications
      .send(null, {
        type,
        to: [...recipients].map((uid) => ({ userId: uid })),
        payload,
        ref: { type: 'hr_action', id: action.id },
        workspaceId: action.workspaceId,
        reason: 'participant',
        actionUrl,
        idempotencyKey: `${type}:${action.id}`,
      })
      .catch(() => undefined);
  }

  // ============================================================
  // Отмена (в т.ч. отзыв заявления работником — ст. 56 п. 4)
  // ============================================================

  async cancelAction(actorId: string, workspaceId: string, actionId: string): Promise<HrActionDto> {
    const action = await this.db.hrAction.findFirst({ where: { id: actionId, workspaceId } });
    if (!action) throw notFound('hr.actionNotFound');

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
        throw forbidden('hr.withdrawNotOwnApplication', undefined, {
          code: HR_ERROR_CODES.withdrawNotOwnApplication,
        });
      }
      throw forbidden('hr.cancelManagerOnly');
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
      throw badRequest('hr.actionNotActive', undefined, { code: HR_ERROR_CODES.actionNotActive });
    }
    // Отложенный джоб применения отменяем (невзятый); executing добьёт статус-гвард
    await this.jobs.cancelByUniqueKey(null, HR_APPLY_JOB, `hrapply:${action.id}`).catch(() => undefined);

    // Неприменённый приказ отменяется; ИЗДАННЫЙ (подписан/зарегистрирован) —
    // кадровику НАСТОЯЩАЯ задача Задачника «издать приказ об отмене» (v1 —
    // полуручной путь: срок, напоминания и приёмка у задачи уже есть).
    const issued = await this.documents.systemCancelForHrAction(action.id, actorId);
    if (issued.issuedLeft > 0) {
      // Задача ложится в БД и живёт своей жизнью как данные — собираем её в языке
      // ИСПОЛНИТЕЛЯ: читать её будет он (docs/i18n.md).
      const locale = await this.i18n.localeOf(action.createdById);
      const t = (key: string, values?: Record<string, string | number>) => this.i18n.translateFor(locale, key, values);
      const kindLabel = t(`hr.actionKind.${action.kind}`);
      const targetName = (await this.nameOf(action.userId)) ?? t('common.labels.someone');
      await this.tasks
        .createTask(
          actorId,
          {
            title: t('hr.cancelTask.title', { kind: kindLabel, name: targetName }),
            description: t('hr.cancelTask.description', {
              kind: kindLabel,
              withdrawn: isOwnApplication ? 'yes' : 'no',
              href: hrMemberHref(workspaceId, action.userId),
            }),
            executorId: action.createdById,
            workspaceId,
          } as Parameters<TasksService['createTask']>[1],
          // Членство обеих сторон уже проверено гейтами КЭДО; окружение не при чём
          { skipEnvironmentChecks: true, origin: 'hr' },
        )
        .catch((e) => this.logger.warn(`counter-order task ${action.id}: ${(e as Error).message}`));
    }

    if (isOwnApplication && !this.isManager(role)) {
      await this.notifications
        .send(null, {
          type: 'hr.action.withdrawn',
          to: [{ userId: action.createdById }],
          payload: {
            ...this.namePayload(await this.nameOf(action.userId)),
            ...(issued.issuedLeft > 0 ? { noteKey: 'hr.withdrawn.orderIssued' } : {}),
            workspaceId,
          },
          ref: { type: 'hr_action', id: action.id },
          workspaceId,
          actorId,
          reason: 'owner',
          actionUrl: hrMemberHref(workspaceId, action.userId),
          idempotencyKey: `hrwd:${action.id}`,
        })
        .catch(() => undefined);
    }
    await this.logMember(actorId, workspaceId, action.userId, 'hr.action_cancelled', {
      kindLabelKey: `hr.actionKind.${action.kind}`,
      ...(isOwnApplication && !this.isManager(role) ? { noteSuffixKey: 'hr.withdrawnSuffix' } : {}),
    });
    return this.getAction(workspaceId, action.id);
  }

  // ============================================================
  // Массовые действия
  // ============================================================

  async createBatch(actorId: string, workspaceId: string, dto: CreateHrBatchInput): Promise<HrActionBatchDto> {
    const actorRole = await this.requireManager(actorId, workspaceId);
    // Пачка увольнений со снятием членства — только владельцу/админу: иначе каждое действие
    // пачки упало бы на том же праве (адресные отказы — владелец в аудитории — ловит createAction)
    if (dto.kind === 'dismissal' && dto.params?.alsoRemoveMembership && actorRole !== 'owner' && actorRole !== 'admin') {
      throw forbidden('workspace.manageForbidden');
    }
    await this.assertApplyRoute(workspaceId, dto.templateId);
    const userIds = await this.resolveAudience(workspaceId, dto.audience, actorRole, actorId);
    if (userIds.length === 0) throw badRequest('hr.audienceEmpty');
    if (userIds.length > HR_LIMITS.batchMax) {
      throw badRequest('hr.batchOverflow', { max: HR_LIMITS.batchMax, picked: userIds.length });
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

  /**
   * Аудитория массового действия — единый словарь core/audiences (команда trainee+,
   * подрядчики исключены, относительные виды по оргструктуре; `$self` = актор).
   * Ранг: массовое действие на «всю организацию» не должно оформлять увольнение
   * Владельцу руками Менеджера. Тихо отсеиваем (а не отказываем всей пачке) —
   * иначе аудитория «вся команда» была бы недоступна никому, кроме Владельца.
   */
  private async resolveAudience(
    workspaceId: string,
    audience: { type: string; id: string }[],
    actorRole?: WorkspaceRole,
    actorId?: string,
  ): Promise<string[]> {
    const ids = await this.audiences.resolve(
      audience as AudienceRef[],
      { workspaceId, selfId: actorId ?? null, initiatorId: actorId ?? null },
      { max: HR_LIMITS.campaignMaxTargets, onOverflow: 'truncate', allowedKinds: CAMPAIGN_AUDIENCE_KINDS },
    );
    if (!ids.length || !actorRole) return ids;
    const live = await this.db.userRole.findMany({
      where: { userId: { in: ids }, context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { notIn: ['contractor'] } },
      select: { userId: true, role: true },
    });
    const manageable = new Set(live.filter((r) => canManageHrSubject(actorRole, r.role as WorkspaceRole)).map((r) => r.userId));
    return ids.filter((id) => manageable.has(id));
  }

  async getBatch(viewerId: string, workspaceId: string, batchId: string): Promise<HrActionBatchDto> {
    await this.requireManager(viewerId, workspaceId);
    const batch = await this.db.hrActionBatch.findFirst({ where: { id: batchId, workspaceId } });
    if (!batch) throw notFound('hr.batchNotFound');
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
    if (!row) throw notFound('hr.actionNotFound');
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
    if (!role || role === 'contractor') throw forbidden('workspace.noAccess');
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
      // Причина — ключ каталога у новых записей и готовая фраза у старых: старые
      // читаются как есть.
      failReason: this.reasonText(row.failReason),
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
