import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONTRACT_MAX_SILENT_EXTENSIONS,
  ESUTD_KINDS,
  ESUTD_TERMINATION_LOCK_NOTE,
  HR_DEADLINE_RULE_MAP,
  HR_ERROR_CODES,
  HR_LIMITS,
  PERSONAL_DOC_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  hrMemberHref,
  type EmploymentDto,
  type EmploymentMismatchDto,
  type EsutdKind,
  type EsutdSubmissionDto,
  type HrActorLite,
  type HrDeadlineItemDto,
  type HrDeadlinesDto,
  type HrMemberCardDto,
  type HrRosterOverviewDto,
  type PersonalDocRecordDto,
  type UpsertEmploymentInput,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { FilesService } from '../../core/files/files.service';
import type { HrPort } from '../documents/documents.service';
import type { HrNodesPort } from '../processes/process-hr-nodes';
import { HrCalendarService } from './hr-calendar.service';
import { HrActionsService } from './hr-actions.service';
import { HR_MEMBER_REF_TYPE, assertCanManageHrSubject, hrMemberRefId } from './hr.constants';
import { fullName } from '../../shared/utils/user-name';

const WS_CONTEXT = 'workspace';

const dateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

function coded(message: string, code: string): BadRequestException {
  return new BadRequestException({ message, details: { code } });
}

/**
 * КЭДО (modules/hr) — тонкий модуль-связка: данные о трудовых отношениях —
 * домен «Сотрудников», бумаги о них — домен «Документооборота», hr их связывает
 * и ничего не хранит дважды. Здесь: трудовая карточка (юридический план),
 * ЕСУТД-очередь, сводный экран «Кадровые сроки», личный архив «Мои документы».
 *
 * `implements HrPort, HrNodesPort` — КОМПИЛЯТОРНАЯ гарантия правила «порт токена
 * ОБЯЗАН покрывать все методы, которые ждут документы и ноды»: пропавший метод
 * раньше падал бы в рантайме внутри ноды, теперь не собирается.
 */
@Injectable()
export class HrService implements HrPort, HrNodesPort {
  private readonly logger = new Logger(HrService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
    private readonly files: FilesService,
    private readonly calendar: HrCalendarService,
    private readonly actions: HrActionsService,
  ) {}

  // ============================================================
  // Гейты (лестница ролей, паттерн Documents/Staff)
  // ============================================================

  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  private async requireTeam(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') throw new ForbiddenException('Подрядчику кадровые данные недоступны');
    return role;
  }

  async requireManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.requireTeam(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw new ForbiddenException('Недостаточно прав (нужен Менеджер или выше)');
    }
    return role;
  }

  isManager(role: WorkspaceRole | null): boolean {
    return !!role && (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  }

  // Гейт карточки (ВКЛЮЧАЯ оклад): Менеджер+ и САМ человек — решение ревью:
  // приказ о приёме обязан печатать оклад (ст. 28 ТК — обязательное условие
  // договора), а видимость документов team|department|managers сделала бы более
  // узкий гейт декоративным. Живёт инлайном в getMemberCard (canSeeEmployment).

  // ============================================================
  // Трудовая карточка (Employment)
  // ============================================================

  serializeEmployment(row: {
    id: string;
    workspaceId: string;
    userId: string;
    status: string;
    hiredAt: Date | null;
    firedAt: Date | null;
    dismissalGround: string | null;
    contractNumber: string | null;
    contractDate: Date | null;
    contractType: string;
    contractEndAt: Date | null;
    contractExtensionsCount: number;
    probationUntil: Date | null;
    legalPositionId: string | null;
    legalPositionName: string | null;
    legalBranchId: string | null;
    legalBranchName: string | null;
    workRate: number | null;
    workSchedule: string | null;
    salaryAmount: bigint | null;
    salaryCurrency: string;
    paperMode: boolean;
    personnelNumber: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): EmploymentDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      status: row.status as EmploymentDto['status'],
      hiredAt: dateStr(row.hiredAt),
      firedAt: dateStr(row.firedAt),
      dismissalGround: row.dismissalGround,
      contractNumber: row.contractNumber,
      contractDate: dateStr(row.contractDate),
      contractType: row.contractType as EmploymentDto['contractType'],
      contractEndAt: dateStr(row.contractEndAt),
      contractExtensionsCount: row.contractExtensionsCount,
      probationUntil: dateStr(row.probationUntil),
      legalPositionId: row.legalPositionId,
      legalPositionName: row.legalPositionName,
      legalBranchId: row.legalBranchId,
      legalBranchName: row.legalBranchName,
      workRate: row.workRate,
      workSchedule: row.workSchedule,
      salaryAmount: row.salaryAmount === null ? null : String(row.salaryAmount),
      salaryCurrency: row.salaryCurrency,
      paperMode: row.paperMode,
      personnelNumber: row.personnelNumber,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Живая (не terminated) трудовая карточка человека — системный поиск */
  async liveEmployment(workspaceId: string, userId: string) {
    return this.db.employment.findFirst({
      where: { workspaceId, userId, status: { not: 'terminated' } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Правка трудовой карточки (Менеджер+). Заводит карточку лениво: у прямой
   * правки статус сразу `active` — «человек уже работает, оформляем бумаги»;
   * приём через кадровое действие идёт своим путём (draft → active в дату).
   */
  async upsertEmployment(
    actorId: string,
    workspaceId: string,
    subjectUserId: string,
    dto: UpsertEmploymentInput,
  ): Promise<EmploymentDto> {
    const actorRole = await this.requireManager(actorId, workspaceId);
    const subjectRole = await this.roleOf(subjectUserId, workspaceId);
    if (!subjectRole || subjectRole === 'contractor') {
      throw new BadRequestException('Трудовая карточка заводится сотруднику организации');
    }
    // Оклад и условия договора человека с равной или более высокой ролью — не
    // епархия Менеджера (та же лестница, что у ролей: админа трогает Владелец).
    assertCanManageHrSubject(actorRole, subjectRole, 'трудовую карточку');
    const snapshots = await this.legalSnapshots(workspaceId, dto.legalPositionId, dto.legalBranchId);

    const existing = await this.liveEmployment(workspaceId, subjectUserId);
    const data = {
      ...(dto.hiredAt !== undefined ? { hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : null } : {}),
      ...(dto.contractNumber !== undefined ? { contractNumber: dto.contractNumber } : {}),
      ...(dto.contractDate !== undefined ? { contractDate: dto.contractDate ? new Date(dto.contractDate) : null } : {}),
      ...(dto.contractType !== undefined ? { contractType: dto.contractType } : {}),
      ...(dto.contractEndAt !== undefined ? { contractEndAt: dto.contractEndAt ? new Date(dto.contractEndAt) : null } : {}),
      ...(dto.contractExtensionsCount !== undefined ? { contractExtensionsCount: dto.contractExtensionsCount } : {}),
      ...(dto.probationUntil !== undefined ? { probationUntil: dto.probationUntil ? new Date(dto.probationUntil) : null } : {}),
      ...(dto.legalPositionId !== undefined
        ? { legalPositionId: dto.legalPositionId, legalPositionName: snapshots.positionName }
        : {}),
      ...(dto.legalBranchId !== undefined
        ? { legalBranchId: dto.legalBranchId, legalBranchName: snapshots.branchName }
        : {}),
      ...(dto.workRate !== undefined ? { workRate: dto.workRate } : {}),
      ...(dto.workSchedule !== undefined ? { workSchedule: dto.workSchedule } : {}),
      ...(dto.salaryAmount !== undefined ? { salaryAmount: dto.salaryAmount === null ? null : BigInt(dto.salaryAmount) } : {}),
      ...(dto.salaryCurrency !== undefined ? { salaryCurrency: dto.salaryCurrency } : {}),
      ...(dto.paperMode !== undefined ? { paperMode: dto.paperMode } : {}),
      ...(dto.personnelNumber !== undefined ? { personnelNumber: dto.personnelNumber } : {}),
    };

    const row = existing
      ? await (async () => {
          const before = existing;
          const updated = await this.db.employment.update({ where: { id: existing.id }, data });
          await this.logEmploymentDiff(actorId, workspaceId, subjectUserId, before, updated);
          return updated;
        })()
      : await (async () => {
          try {
            const created = await this.db.employment.create({
              data: { workspaceId, userId: subjectUserId, status: 'active', createdById: actorId, ...data },
            });
            await this.logMember(actorId, workspaceId, subjectUserId, 'hr.action_created', {
              kindLabel: 'Трудовая карточка заведена',
              documentSuffix: '',
            });
            return created;
          } catch (err) {
            // Партиальный уникум hr_employments_one_live: параллельное создание
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
              const twin = await this.liveEmployment(workspaceId, subjectUserId);
              if (twin) return this.db.employment.update({ where: { id: twin.id }, data });
            }
            throw err;
          }
        })();
    return this.serializeEmployment(row);
  }

  /** Снимки названий должности/филиала по договору (валидируются принадлежностью) */
  async legalSnapshots(
    workspaceId: string,
    positionId?: string | null,
    branchId?: string | null,
  ): Promise<{ positionName: string | null; branchName: string | null }> {
    let positionName: string | null = null;
    let branchName: string | null = null;
    if (positionId) {
      const pos = await this.db.staffPosition.findFirst({ where: { id: positionId, workspaceId }, select: { name: true } });
      if (!pos) throw new BadRequestException('Должность не найдена в этой организации');
      positionName = pos.name;
    }
    if (branchId) {
      const br = await this.db.staffBranch.findFirst({ where: { id: branchId, workspaceId }, select: { name: true } });
      if (!br) throw new BadRequestException('Филиал не найден в этой организации');
      branchName = br.name;
    }
    return { positionName, branchName };
  }

  /** Дифф трудовой карточки — в хронику человека (одной записью на поле) */
  private async logEmploymentDiff(
    actorId: string,
    workspaceId: string,
    subjectUserId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    const tracked: [string, string][] = [
      ['salaryAmount', 'оклад'],
      ['legalPositionName', 'должность по договору'],
      ['legalBranchName', 'филиал по договору'],
      ['contractNumber', 'номер договора'],
      ['contractEndAt', 'окончание договора'],
      ['probationUntil', 'испытательный срок'],
      ['paperMode', 'бумажный режим'],
    ];
    for (const [field, label] of tracked) {
      const from = before[field];
      const to = after[field];
      const norm = (v: unknown) =>
        v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '—' : String(v);
      if (norm(from) === norm(to)) continue;
      await this.chatter
        .log(null, {
          refType: HR_MEMBER_REF_TYPE,
          refId: hrMemberRefId(workspaceId, subjectUserId),
          workspaceId,
          actorId,
          actorName: await this.nameOf(actorId),
          typeKey: 'hr.employment_updated',
          changes: [{ field, label, from: norm(from), to: norm(to) }],
          payload: { fieldLabel: label },
        })
        .catch(() => undefined);
    }
  }

  async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return u ? fullName(u) : 'Кто-то';
  }

  /** Запись в хронику человека (workspaceId заполнен → видна и в журнале организации) */
  async logMember(
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
  // Страница человека и ростер
  // ============================================================

  async getMemberCard(viewerId: string, workspaceId: string, subjectUserId: string): Promise<HrMemberCardDto> {
    const viewerRole = await this.requireTeam(viewerId, workspaceId);
    const subjectRole = await this.roleOf(subjectUserId, workspaceId);
    if (!subjectRole) {
      /**
       * Человека в организации больше нет — но у КАДРОВИКА карточка обязана
       * открываться: увольнение «и то и другое» снимает членство, и до починки
       * сразу после применения приказа страница отвечала 404 — ровно тогда,
       * когда на неё ведут «Кадровые сроки» (расчёт 3 РД, вручение акта) и
       * уведомление о применении. Рядовому — по-прежнему 404.
       */
      const hasHrTrace =
        this.isManager(viewerRole) &&
        ((await this.db.employment.count({ where: { workspaceId, userId: subjectUserId } })) > 0 ||
          (await this.db.hrAction.count({ where: { workspaceId, userId: subjectUserId } })) > 0);
      if (!hasHrTrace) throw new NotFoundException('Этот человек не в организации');
    }

    const [user, assignments, liveEmp] = await Promise.all([
      this.db.user.findUnique({
        where: { id: subjectUserId },
        select: { id: true, firstName: true, lastName: true, avatar: true, phone: true },
      }),
      this.db.staffAssignment.findMany({
        where: { workspaceId, userId: subjectUserId },
        // Основное место (isPrimary) — первым: плашка «факт ≠ договор» и карточка
        // сравнивают договор с ОСНОВНЫМ назначением, а не с первым по дате.
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        include: {
          position: { select: { name: true, department: { select: { name: true } } } },
          branch: { select: { name: true } },
        },
      }),
      this.liveEmployment(workspaceId, subjectUserId),
    ]);
    // После увольнения карточка показывает ПОСЛЕДНЮЮ запись (терминированную) —
    // «уволен, основание, дата» это ровно то, зачем на неё смотрят.
    const employment =
      liveEmp ??
      (await this.db.employment.findFirst({
        where: { workspaceId, userId: subjectUserId },
        orderBy: { createdAt: 'desc' },
      }));
    if (!user) throw new NotFoundException('Пользователь не найден');

    const canSeeEmployment = viewerId === subjectUserId || this.isManager(viewerRole);
    // Черновики действий — только управляющим: готовящийся приказ (основание
    // увольнения, дата, новый оклад) субъекту не показывается, как и черновик
    // самого документа.
    const actions = canSeeEmployment
      ? await this.actions.listForUser(workspaceId, subjectUserId, 20, { includeDrafts: this.isManager(viewerRole) })
      : [];
    // Счётчик «Документы · N» — тоже сведение о человеке: постороннему коллеге
    // число приказов о нём знать незачем.
    const documentsCount = canSeeEmployment
      ? await this.db.orgDocument.count({ where: { workspaceId, subjectUserId } })
      : 0;

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        phone: user.phone,
      },
      role: subjectRole,
      assignments: assignments.map((a) => ({
        id: a.id,
        positionId: a.positionId,
        positionName: a.position.name,
        departmentName: a.position.department?.name ?? null,
        branchId: a.branchId,
        branchName: a.branch?.name ?? null,
        status: a.status,
      })),
      employment: canSeeEmployment && employment ? this.serializeEmployment(employment) : null,
      mismatch: this.computeMismatch(
        assignments.map((a) => ({
          positionId: a.positionId,
          positionName: a.position.name,
          branchId: a.branchId,
          branchName: a.branch?.name ?? null,
        })),
        employment,
      ),
      actions,
      documentsCount,
      canManage: this.isManager(viewerRole),
      canSeeEmployment,
    };
  }

  /**
   * Расхождение «факт ≠ договор» — плашка, не ошибка. Совпадением считаем:
   * договорная должность есть среди фактических назначений (филиал сверяется,
   * только если задан в договоре).
   */
  private computeMismatch(
    assignments: { positionId: string; positionName: string; branchId: string | null; branchName: string | null }[],
    employment: { legalPositionId: string | null; legalPositionName: string | null; legalBranchId: string | null; legalBranchName: string | null } | null,
  ): EmploymentMismatchDto {
    const first = assignments[0] ?? null;
    const base = {
      factPositionName: first?.positionName ?? null,
      factBranchName: first?.branchName ?? null,
      legalPositionName: employment?.legalPositionName ?? null,
      legalBranchName: employment?.legalBranchName ?? null,
    };
    if (!employment?.legalPositionId || assignments.length === 0) return { mismatch: false, ...base };
    const matches = assignments.some(
      (a) =>
        a.positionId === employment.legalPositionId &&
        (!employment.legalBranchId || a.branchId === employment.legalBranchId),
    );
    return { mismatch: !matches, ...base };
  }

  /** Кадровая сводка ростера (Менеджер+): фильтры «нет договора / расхождение» */
  async rosterOverview(viewerId: string, workspaceId: string): Promise<HrRosterOverviewDto> {
    await this.requireManager(viewerId, workspaceId);
    const [employments, assignments] = await Promise.all([
      this.db.employment.findMany({
        where: { workspaceId, status: { not: 'terminated' } },
        select: { userId: true, status: true, legalPositionId: true, legalBranchId: true },
      }),
      this.db.staffAssignment.findMany({
        where: { workspaceId },
        select: { userId: true, positionId: true, branchId: true },
      }),
    ]);
    const factByUser = new Map<string, { positionId: string; branchId: string | null }[]>();
    for (const a of assignments) {
      const list = factByUser.get(a.userId) ?? [];
      list.push({ positionId: a.positionId, branchId: a.branchId });
      factByUser.set(a.userId, list);
    }
    const byUser: HrRosterOverviewDto['byUser'] = {};
    for (const e of employments) {
      const facts = factByUser.get(e.userId) ?? [];
      const mismatch =
        !!e.legalPositionId &&
        facts.length > 0 &&
        !facts.some((f) => f.positionId === e.legalPositionId && (!e.legalBranchId || f.branchId === e.legalBranchId));
      byUser[e.userId] = { status: e.status as 'draft' | 'active' | 'terminated', mismatch };
    }
    return { byUser };
  }

  // ============================================================
  // ЕСУТД
  // ============================================================

  /** Поставить сдачу в очередь (системный путь — из применения действия / ноды hr.esutd) */
  async ensureEsutdSubmission(opts: {
    workspaceId: string;
    userId: string;
    kind: EsutdKind;
    baseDate: string; // от какого события считается срок
    hrActionId?: string | null;
    employmentId?: string | null;
  }): Promise<void> {
    const rule = HR_DEADLINE_RULE_MAP[ESUTD_KINDS.find((k) => k.value === opts.kind)!.ruleKey];
    let dueAt: string;
    try {
      dueAt =
        rule.unit === 'work_days'
          ? await this.calendar.addWorkDays(opts.baseDate, rule.amount)
          : this.calendar.addCalendarDays(opts.baseDate, rule.amount);
    } catch {
      // За горизонтом календаря — срок кладём календарным счётом с пометкой:
      // строка в очереди важнее точности (её пересчитает экран по живому календарю)
      dueAt = this.calendar.addCalendarDays(opts.baseDate, rule.amount);
    }
    // Дедуп: одна живая сдача на (действие, вид)
    const existing = await this.db.esutdSubmission.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        kind: opts.kind,
        status: 'pending',
        ...(opts.hrActionId ? { hrActionId: opts.hrActionId } : {}),
      },
      select: { id: true },
    });
    if (existing) return;
    await this.db.esutdSubmission.create({
      data: {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        kind: opts.kind,
        hrActionId: opts.hrActionId ?? null,
        employmentId: opts.employmentId ?? null,
        dueAt: new Date(dueAt),
        payload: {},
      },
    });
  }

  async listEsutd(viewerId: string, workspaceId: string, status?: string): Promise<{ items: EsutdSubmissionDto[]; actors: Record<string, HrActorLite> }> {
    await this.requireManager(viewerId, workspaceId);
    const rows = await this.db.esutdSubmission.findMany({
      where: { workspaceId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 200,
    });
    const today = this.calendar.today();
    const items: EsutdSubmissionDto[] = [];
    for (const r of rows) {
      items.push(await this.serializeEsutd(r, today));
    }
    return { items, actors: await this.actorsOf(rows.map((r) => r.userId)) };
  }

  private async serializeEsutd(
    r: {
      id: string;
      workspaceId: string;
      userId: string;
      kind: string;
      hrActionId: string | null;
      employmentId: string | null;
      dueAt: Date;
      status: string;
      submittedAt: Date | null;
      submittedById: string | null;
      externalNumber: string | null;
      correctionUntil: Date | null;
      payload: unknown;
      createdAt: Date;
    },
    today: string,
  ): Promise<EsutdSubmissionDto> {
    const due = dateStr(r.dueAt)!;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      userId: r.userId,
      kind: r.kind as EsutdKind,
      hrActionId: r.hrActionId,
      employmentId: r.employmentId,
      dueAt: due,
      status: r.status as EsutdSubmissionDto['status'],
      submittedAt: r.submittedAt?.toISOString() ?? null,
      submittedById: r.submittedById,
      externalNumber: r.externalNumber,
      correctionUntil: dateStr(r.correctionUntil),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
      workDaysLeft: r.status === 'pending' ? await this.calendar.workDaysLeft(today, due) : null,
    };
  }

  /**
   * «Отметить сданным» — ручной путь (драйвер API ЦРТР подключится, когда дадут
   * доступ). Считает окно исправления: 30 РАБОЧИХ дней без штрафа.
   *
   * ПРЕКРАЩЕНИЕ — операция БЕЗ ОТКАТА (п. 13 Правил № 353: после отправки
   * правка только через госорган по обращению), поэтому строгая валидация
   * полноты сведений стоит ДО отметки: неполнота = недостоверность = штраф
   * (ст. 98 п. 1-1 КоАП).
   */
  async markEsutdSubmitted(
    viewerId: string,
    workspaceId: string,
    submissionId: string,
    externalNumber?: string,
  ): Promise<EsutdSubmissionDto> {
    await this.requireManager(viewerId, workspaceId);
    const row = await this.db.esutdSubmission.findFirst({ where: { id: submissionId, workspaceId } });
    if (!row) throw new NotFoundException('Запись очереди ЕСУТД не найдена');
    if (row.status !== 'pending') {
      if (row.kind === 'termination' && row.status === 'submitted') {
        throw coded(ESUTD_TERMINATION_LOCK_NOTE, HR_ERROR_CODES.esutdLocked);
      }
      throw new BadRequestException('Эта запись уже закрыта');
    }
    if (row.kind === 'termination') {
      const payload = await this.buildEsutdPayload(workspaceId, row);
      const required = ['ФИО работника', 'ИИН работника', 'БИН работодателя', 'Дата прекращения', 'Основание прекращения'];
      const missing = required.filter((k) => payload[k] === null || payload[k] === undefined || payload[k] === '');
      if (missing.length > 0) {
        throw coded(
          `Сведения о прекращении неполны: ${missing.join(', ')}. ${ESUTD_TERMINATION_LOCK_NOTE}`,
          HR_ERROR_CODES.esutdIncomplete,
        );
      }
      // Снимок того, что уходило в ЕСУТД, — на строке (доказательство содержания)
      await this.db.esutdSubmission.update({ where: { id: row.id }, data: { payload: payload as object } });
    }
    const today = this.calendar.today();
    let correctionUntil: string | null = null;
    try {
      // Срок — из единого справочника норм, не литералом (правило раздела:
      // единица и величина живут в HR_DEADLINE_RULES, иначе копия разъедется)
      const rule = HR_DEADLINE_RULE_MAP.esutd_correction;
      correctionUntil =
        rule.unit === 'work_days'
          ? await this.calendar.addWorkDays(today, rule.amount)
          : this.calendar.addCalendarDays(today, rule.amount);
    } catch {
      correctionUntil = null;
    }
    const updated = await this.db.esutdSubmission.update({
      where: { id: row.id },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        submittedById: viewerId,
        externalNumber: externalNumber ?? null,
        correctionUntil: correctionUntil ? new Date(correctionUntil) : null,
      },
    });
    await this.logMember(viewerId, workspaceId, row.userId, 'hr.esutd_submitted', {
      kindLabel: ESUTD_KINDS.find((k) => k.value === row.kind)?.label ?? row.kind,
      numberSuffix: externalNumber ? ` (№ ${externalNumber})` : '',
    });
    return this.serializeEsutd(updated, today);
  }

  async markEsutdNotRequired(viewerId: string, workspaceId: string, submissionId: string): Promise<EsutdSubmissionDto> {
    await this.requireManager(viewerId, workspaceId);
    const row = await this.db.esutdSubmission.findFirst({ where: { id: submissionId, workspaceId } });
    if (!row) throw new NotFoundException('Запись очереди ЕСУТД не найдена');
    if (row.status !== 'pending') {
      if (row.kind === 'termination' && row.status === 'submitted') {
        throw coded(ESUTD_TERMINATION_LOCK_NOTE, HR_ERROR_CODES.esutdLocked);
      }
      throw new BadRequestException('Эта запись уже закрыта');
    }
    const updated = await this.db.esutdSubmission.update({
      where: { id: row.id },
      data: { status: 'not_required', submittedById: viewerId },
    });
    return this.serializeEsutd(updated, this.calendar.today());
  }

  /** Снимок по перечню Правил № 353 — одна сборка для «Скопировать» и валидации сдачи */
  private async buildEsutdPayload(
    workspaceId: string,
    row: { kind: string; userId: string; employmentId: string | null },
  ): Promise<Record<string, unknown>> {
    const [user, employment, ws] = await Promise.all([
      this.db.user.findUnique({
        where: { id: row.userId },
        select: { firstName: true, lastName: true, middleName: true, iin: true },
      }),
      row.employmentId ? this.db.employment.findUnique({ where: { id: row.employmentId } }) : this.liveEmployment(workspaceId, row.userId),
      this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true, requisites: { select: { bin: true, legalName: true } } },
      }),
    ]);
    return {
      'Вид сведений': ESUTD_KINDS.find((k) => k.value === row.kind)?.label ?? row.kind,
      'Работодатель': ws?.requisites?.legalName ?? ws?.name ?? null,
      'БИН работодателя': ws?.requisites?.bin ?? null,
      'ФИО работника': user ? [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') : null,
      'ИИН работника': user?.iin ?? null,
      'Номер договора': employment?.contractNumber ?? null,
      'Дата договора': dateStr(employment?.contractDate ?? null),
      'Дата начала работы': dateStr(employment?.hiredAt ?? null),
      'Должность': employment?.legalPositionName ?? null,
      'Вид договора': employment?.contractType ?? null,
      'Дата окончания (срочный)': dateStr(employment?.contractEndAt ?? null),
      ...(row.kind === 'termination'
        ? {
            'Дата прекращения': dateStr(employment?.firedAt ?? null),
            'Основание прекращения': employment?.dismissalGround ?? null,
          }
        : {}),
    };
  }

  /** Снимок сведений для «Скопировать сведения» (по перечню Правил № 353) */
  async esutdPayload(viewerId: string, workspaceId: string, submissionId: string): Promise<Record<string, unknown>> {
    await this.requireManager(viewerId, workspaceId);
    const row = await this.db.esutdSubmission.findFirst({ where: { id: submissionId, workspaceId } });
    if (!row) throw new NotFoundException('Запись очереди ЕСУТД не найдена');
    const payload = await this.buildEsutdPayload(workspaceId, row);
    // Снимок отправленного сохраняем на строке (что именно копировали)
    await this.db.esutdSubmission.update({ where: { id: row.id }, data: { payload: payload as object } });
    return payload;
  }

  // ============================================================
  // Сводный экран «Кадровые сроки»
  // ============================================================

  async getDeadlines(viewerId: string, workspaceId: string): Promise<HrDeadlinesDto> {
    await this.requireManager(viewerId, workspaceId);
    const today = this.calendar.today();
    const userIds = new Set<string>();
    const push = (id: string | null) => {
      if (id) userIds.add(id);
    };

    // 1) ЕСУТД: несданное + окна исправления
    const esutdRows = await this.db.esutdSubmission.findMany({
      where: { workspaceId, status: 'pending' },
      orderBy: { dueAt: 'asc' },
      take: HR_LIMITS.deadlinesPerSection,
    });
    const esutd: HrDeadlineItemDto[] = [];
    for (const r of esutdRows) {
      const due = dateStr(r.dueAt)!;
      const left = await this.calendar.workDaysLeft(today, due);
      push(r.userId);
      esutd.push({
        key: `esutd:${r.id}`,
        kind: 'esutd',
        userId: r.userId,
        title: ESUTD_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind,
        subtitle: HR_DEADLINE_RULE_MAP[ESUTD_KINDS.find((k) => k.value === r.kind)!.ruleKey].article,
        dueAt: due,
        workDaysLeft: left,
        overdue: due < today,
        href: null,
      });
    }

    // 2) Вручения (виды со specialDelivery: подписанный акт без фиксации вручения)
    const deliveryDocs = await this.db.orgDocument.findMany({
      where: {
        workspaceId,
        deliveredAt: null,
        status: { in: ['signed', 'registered', 'active'] },
        docType: { specialDelivery: true },
      },
      orderBy: { signedAt: 'asc' },
      take: HR_LIMITS.deadlinesPerSection,
      select: { id: true, title: true, number: true, subjectUserId: true, signedAt: true, createdAt: true },
    });
    const deliveries: HrDeadlineItemDto[] = [];
    for (const d of deliveryDocs) {
      const base = dateStr(d.signedAt) ?? dateStr(d.createdAt)!;
      let due: string | null = null;
      try {
        // ст. 61 п. 3 — из единого справочника норм, не литералом
        due = await this.calendar.addWorkDays(base, HR_DEADLINE_RULE_MAP.termination_act_delivery.amount);
      } catch {
        due = null;
      }
      push(d.subjectUserId);
      deliveries.push({
        key: `delivery:${d.id}`,
        kind: 'delivery',
        userId: d.subjectUserId,
        title: d.number ? `${d.title} № ${d.number}` : d.title,
        subtitle: 'Вручить в течение 3 рабочих дней (ст. 61 п. 3 ТК РК)',
        dueAt: due,
        workDaysLeft: due ? await this.calendar.workDaysLeft(today, due) : null,
        overdue: !!due && due < today,
        href: `/workspaces/${workspaceId}/documents/${d.id}`,
      });
    }

    // 3) Расчёты и документ о трудовой деятельности (свежие увольнения ≤ 30 дней)
    const fired = await this.db.employment.findMany({
      where: {
        workspaceId,
        status: 'terminated',
        firedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      orderBy: { firedAt: 'desc' },
      take: HR_LIMITS.deadlinesPerSection,
      select: { id: true, userId: true, firedAt: true },
    });
    const settlements: HrDeadlineItemDto[] = [];
    for (const f of fired) {
      const base = dateStr(f.firedAt)!;
      let due: string | null = null;
      try {
        // ст. 113 п. 4 — из единого справочника норм, не литералом
        due = await this.calendar.addWorkDays(base, HR_DEADLINE_RULE_MAP.final_settlement.amount);
      } catch {
        due = null;
      }
      push(f.userId);
      settlements.push({
        key: `settle:${f.id}`,
        kind: 'settlement',
        userId: f.userId,
        title: 'Окончательный расчёт и документ о трудовой деятельности',
        subtitle: 'Расчёт — 3 рабочих дня (ст. 113 п. 4, пеня 1,25× базовой ставки); документ — в день прекращения (ст. 62)',
        dueAt: due,
        workDaysLeft: due ? await this.calendar.workDaysLeft(today, due) : null,
        overdue: !!due && due < today,
        href: hrMemberHref(workspaceId, f.userId),
      });
    }

    // 4) Испытательные сроки, подходящие к концу
    const probations = await this.db.employment.findMany({
      where: {
        workspaceId,
        status: { in: ['draft', 'active'] },
        probationUntil: {
          gte: new Date(today),
          lte: new Date(this.calendar.addCalendarDays(today, HR_LIMITS.probationWarnDays)),
        },
      },
      orderBy: { probationUntil: 'asc' },
      take: HR_LIMITS.deadlinesPerSection,
      select: { id: true, userId: true, probationUntil: true },
    });
    const probationItems: HrDeadlineItemDto[] = probations.map((p) => {
      push(p.userId);
      const due = dateStr(p.probationUntil)!;
      return {
        key: `probation:${p.id}`,
        kind: 'probation' as const,
        userId: p.userId,
        title: 'Испытательный срок заканчивается',
        subtitle: 'Не уведомили до истечения — работник считается прошедшим (ст. 37 ТК РК)',
        dueAt: due,
        workDaysLeft: null,
        overdue: false,
        href: hrMemberHref(workspaceId, p.userId),
      };
    });

    // 5) Окончания срочных договоров
    const contracts = await this.db.employment.findMany({
      where: {
        workspaceId,
        status: { in: ['draft', 'active'] },
        contractType: { in: ['fixed_term', 'seasonal', 'task_based'] },
        contractEndAt: {
          gte: new Date(today),
          lte: new Date(this.calendar.addCalendarDays(today, HR_LIMITS.contractWarnDays)),
        },
      },
      orderBy: { contractEndAt: 'asc' },
      take: HR_LIMITS.deadlinesPerSection,
      select: { id: true, userId: true, contractEndAt: true, contractExtensionsCount: true },
    });
    const contractEnds: HrDeadlineItemDto[] = contracts.map((c) => {
      push(c.userId);
      const due = dateStr(c.contractEndAt)!;
      const third = c.contractExtensionsCount >= CONTRACT_MAX_SILENT_EXTENSIONS;
      return {
        key: `contract:${c.id}`,
        kind: 'contract_end' as const,
        userId: c.userId,
        title: third ? 'Срочный договор: продлевался молчанием 2 раза — считается бессрочным' : 'Срочный договор заканчивается',
        subtitle: 'Уведомить в последний рабочий день, иначе автопродление (ст. 30 п. 1 пп. 2 ТК РК)',
        dueAt: due,
        workDaysLeft: null,
        overdue: false,
        href: hrMemberHref(workspaceId, c.userId),
      };
    });

    // 6) Кампании ознакомления с неознакомившимися
    const campaigns = await this.db.docCampaign.findMany({
      where: { workspaceId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      take: HR_LIMITS.deadlinesPerSection,
      include: { _count: { select: { targets: true } } },
    });
    const campaignItems: HrDeadlineItemDto[] = [];
    for (const c of campaigns) {
      const pending = await this.db.docCampaignTarget.count({ where: { campaignId: c.id, status: 'pending' } });
      if (pending === 0) continue;
      campaignItems.push({
        key: `campaign:${c.id}`,
        kind: 'campaign',
        userId: null,
        title: `Ознакомление: «${c.title}»`,
        subtitle: `Не ознакомились ${pending} из ${c._count.targets}`,
        dueAt: dateStr(c.dueAt),
        workDaysLeft: null,
        overdue: !!c.dueAt && dateStr(c.dueAt)! < today,
        href: `/workspaces/${workspaceId}/documents?tab=campaigns`,
      });
    }

    const total =
      esutd.length + deliveries.length + settlements.length + probationItems.length + contractEnds.length + campaignItems.length;
    return {
      esutd,
      deliveries,
      settlements,
      probations: probationItems,
      contractEnds,
      campaigns: campaignItems,
      total,
      actors: await this.actorsOf([...userIds]),
    };
  }

  /** Лёгкий счётчик «горит» для бейджа пункта «Сотрудники» (Менеджер+; иначе 0) */
  async deadlinesCount(viewerId: string, workspaceId: string): Promise<number> {
    const role = await this.roleOf(viewerId, workspaceId);
    if (!this.isManager(role)) return 0;
    const today = this.calendar.today();
    const [esutd, deliveries] = await Promise.all([
      this.db.esutdSubmission.count({ where: { workspaceId, status: 'pending' } }),
      this.db.orgDocument.count({
        where: {
          workspaceId,
          deliveredAt: null,
          status: { in: ['signed', 'registered', 'active'] },
          docType: { specialDelivery: true },
        },
      }),
    ]);
    // Окно то же, что у экрана «Кадровые сроки» (30 дней): бейдж, считающий по
    // своему окну, показывает не то число, что открывшаяся под ним страница.
    const settlements = await this.db.employment.count({
      where: { workspaceId, status: 'terminated', firedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    });
    const probations = await this.db.employment.count({
      where: {
        workspaceId,
        status: { in: ['draft', 'active'] },
        probationUntil: { gte: new Date(today), lte: new Date(this.calendar.addCalendarDays(today, HR_LIMITS.probationWarnDays)) },
      },
    });
    return esutd + deliveries + settlements + probations;
  }

  async actorsOf(userIds: string[]): Promise<Record<string, HrActorLite>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return {};
    const rows = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return rows.reduce(
      (acc, u) => ({ ...acc, [u.id]: { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar } }),
      {} as Record<string, HrActorLite>,
    );
  }

  // ============================================================
  // Личный архив «Мои документы» (PersonalDocRecord)
  // ============================================================

  /**
   * Записать «документ достиг человека» + FileLink `personal_doc` на ТОТ ЖЕ
   * FileObject — файл получает живое место и переживает purge организации.
   * Идемпотентно (партиальный уникум): пути события зовут at-least-once.
   */
  async recordReached(opts: {
    userId: string;
    workspaceId: string;
    orgDocumentId: string | null;
    kind: 'signed' | 'acknowledged' | 'delivered';
    fileId: string;
    title: string;
    number?: string | null;
    docTypeName?: string | null;
    signRequestId?: string | null;
    stampedFileId?: string | null;
  }): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const record = await tx.personalDocRecord.create({
          data: {
            userId: opts.userId,
            workspaceId: opts.workspaceId,
            workspaceName:
              (await tx.workspace.findUnique({ where: { id: opts.workspaceId }, select: { name: true } }))?.name ??
              'Организация',
            orgDocumentId: opts.orgDocumentId,
            title: opts.title,
            number: opts.number ?? null,
            docTypeName: opts.docTypeName ?? null,
            fileId: opts.fileId,
            stampedFileId: opts.stampedFileId ?? null,
            signRequestId: opts.signRequestId ?? null,
            kind: opts.kind,
          },
        });
        await this.files.linkSystemInTx(tx, {
          fileId: opts.fileId,
          refType: PERSONAL_DOC_REF_TYPE,
          refId: record.id,
          createdById: opts.userId,
        });
      });
    } catch (err) {
      // Партиальный уникум (user, документ, kind): событие уже записано — no-op
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') return;
      throw err;
    }
  }

  /** «Мои документы» — личный пункт: переживает увольнение и закрытие компании */
  async listMyDocs(userId: string): Promise<{ items: PersonalDocRecordDto[] }> {
    const rows = await this.db.personalDocRecord.findMany({
      where: { userId },
      orderBy: { reachedAt: 'desc' },
      take: 200,
    });
    const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
    const aliveWs = new Set(
      (
        await this.db.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true } })
      ).map((w) => w.id),
    );
    // Заявки и акты подписи — ДВУМЯ батчами на весь экран, а не по три запроса
    // на строку: «Мои документы» отдают до 200 записей, и на пути к ним стоял
    // ещё и presign каждой ссылки.
    const requestIds = [...new Set(rows.map((r) => r.signRequestId).filter((id): id is string => !!id))];
    const stampedByRequest = new Map<string, string | null>();
    const actByRequest = new Map<string, { id: string; checkToken: string }>();
    if (requestIds.length) {
      const [requests, acts] = await Promise.all([
        this.db.signRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, stampedFileId: true },
        }),
        this.db.signAct.findMany({
          where: { requestId: { in: requestIds }, signerUserId: userId, status: 'signed' },
          select: { id: true, requestId: true, checkToken: true },
        }),
      ]);
      requests.forEach((q) => stampedByRequest.set(q.id, q.stampedFileId));
      acts.forEach((a) => actByRequest.set(a.requestId, { id: a.id, checkToken: a.checkToken }));
    }

    const items: PersonalDocRecordDto[] = [];
    for (const r of rows) {
      // Штампованная копия дописывается ЛЕНИВО: джоб штампа мог дожеваться позже
      // записи (и переживает purge — у sign_requests нет FK на организацию).
      let stampedFileId = r.stampedFileId;
      if (!stampedFileId && r.signRequestId) {
        const fresh = stampedByRequest.get(r.signRequestId) ?? null;
        if (fresh) {
          stampedFileId = fresh;
          await this.db.personalDocRecord
            .update({ where: { id: r.id }, data: { stampedFileId } })
            .catch(() => undefined);
        }
      }
      const fileForDownload = stampedFileId ?? r.fileId;
      let downloadUrl: string | null = null;
      try {
        downloadUrl = (await this.files.buildSystemDownloadUrl(fileForDownload)).url;
      } catch {
        downloadUrl = null;
      }
      let checkUrl: string | null = null;
      if (r.signRequestId) {
        const act = actByRequest.get(r.signRequestId);
        if (act) checkUrl = `/check/${act.id}?k=${act.checkToken}`;
      }
      items.push({
        id: r.id,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        orgDocumentId: r.orgDocumentId,
        workspaceAlive: aliveWs.has(r.workspaceId),
        title: r.title,
        number: r.number,
        docTypeName: r.docTypeName,
        kind: r.kind as PersonalDocRecordDto['kind'],
        reachedAt: r.reachedAt.toISOString(),
        downloadUrl,
        checkUrl,
      });
    }
    return { items };
  }

  // ============================================================
  // Порт для «Документооборота» (ленивое ребро, см. DocumentsModule)
  // ============================================================

  /**
   * Акт подписи по документу закрылся (зовёт провайдер Документооборота).
   * Работник подписал свой документ → личная запись-архив; акт РАБОТОДАТЕЛЯ
   * сертификатом физлица (без БИН) на кадровом документе → предупреждение в
   * хронику (v1 — warning, жёсткость после ответа юриста).
   */
  async onDocumentActFinished(
    documentId: string,
    info: { outcome: 'signed' | 'declined'; level: 'ecp' | 'pep'; signerUserId: string | null; signRequestId: string; certSubjectBin: string | null },
  ): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      include: { docType: { select: { name: true, category: true } } },
    });
    if (!doc || info.outcome !== 'signed') return;

    if (info.signerUserId && doc.subjectUserId === info.signerUserId) {
      const request = await this.db.signRequest.findUnique({
        where: { id: info.signRequestId },
        select: { subjectFileId: true, stampedFileId: true },
      });
      // Файл записи — ЗАМОРОЖЕННЫЙ предмет подписи (профиль доказательств: вечен,
      // вне квоты, не удаляется никем) — ровно те байты, которые человек подписал.
      await this.recordReached({
        userId: info.signerUserId,
        workspaceId: doc.workspaceId,
        orgDocumentId: doc.id,
        kind: 'signed',
        fileId: request?.subjectFileId ?? doc.fileId ?? '',
        title: doc.title,
        number: doc.number,
        docTypeName: doc.docType.name,
        signRequestId: info.signRequestId,
        stampedFileId: request?.stampedFileId ?? null,
      }).catch((e) => this.logger.warn(`personal record ${documentId}: ${(e as Error).message}`));
    }

    // Предупреждение: акт работодателя (подписант ≠ сторона) кадрового документа
    // подписан ЭЦП физлица — сертификата юрлица (с БИН) в ключе нет. Свой
    // typeKey: под маской hr.action_failed это читалось бы как «не применено».
    if (
      info.level === 'ecp' &&
      !info.certSubjectBin &&
      info.signerUserId &&
      doc.subjectUserId !== info.signerUserId &&
      doc.docType.category === 'hr'
    ) {
      await this.logMember(null, doc.workspaceId, doc.subjectUserId ?? info.signerUserId, 'hr.sign_bin_warning', {
        reason: `акт работодателя «${doc.title}» подписан сертификатом физлица (без БИН юрлица) — для актов работодателя вероятно нужен сертификат сотрудника юрлица`,
      });
    }
  }

  /** Порт HrPort: машина действия живёт в HrActionsService — делегируем */
  onDocumentSubmitted(hrActionId: string): Promise<void> {
    return this.actions.onDocumentSubmitted(hrActionId);
  }
  /** Нода hr.apply тоже резолвит ТОКЕН HrService — делегат обязателен */
  onRouteReachedApply(hrActionId: string): Promise<{ scheduled: boolean }> {
    return this.actions.onRouteReachedApply(hrActionId);
  }
  onDocumentWithdrawn(hrActionId: string): Promise<void> {
    return this.actions.onDocumentWithdrawn(hrActionId);
  }
  onDocumentCancelled(hrActionId: string, documentId: string): Promise<void> {
    return this.actions.onDocumentCancelled(hrActionId, documentId);
  }
  onDocumentResolved(hrActionId: string, outcome: 'approved' | 'rejected' | 'returned' | 'cancelled'): Promise<void> {
    return this.actions.onDocumentResolved(hrActionId, outcome);
  }

  /**
   * Сторона документа ознакомилась по шагу МАРШРУТА (клик в «Ждут решения»).
   * Тот же юридический факт, что клик в кампании (ст. 23 п. 2 пп. 6 ТК РК), —
   * и та же личная запись kind='acknowledged': экран «Мои документы» обещает
   * «всё, с чем ознакомитесь», и путь фиксации не должен на это влиять.
   */
  async onDocumentAcknowledged(documentId: string, userId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      include: { docType: { select: { name: true } } },
    });
    if (!doc?.fileId || doc.subjectUserId !== userId) return;
    await this.recordReached({
      userId,
      workspaceId: doc.workspaceId,
      orgDocumentId: doc.id,
      kind: 'acknowledged',
      fileId: doc.pdfFileId ?? doc.fileId,
      title: doc.title,
      number: doc.number,
      docTypeName: doc.docType.name,
    }).catch((e) => this.logger.warn(`personal record (route ack) ${documentId}: ${(e as Error).message}`));
  }

  /** Вручение зафиксировано → «документ достиг человека» (личная запись-архив) */
  async onDocumentDelivered(documentId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      include: { docType: { select: { name: true } } },
    });
    if (!doc?.subjectUserId || !doc.fileId) return;
    await this.recordReached({
      userId: doc.subjectUserId,
      workspaceId: doc.workspaceId,
      orgDocumentId: doc.id,
      kind: 'delivered',
      fileId: doc.pdfFileId ?? doc.fileId,
      title: doc.title,
      number: doc.number,
      docTypeName: doc.docType.name,
    }).catch((e) => this.logger.warn(`personal record (delivered) ${documentId}: ${(e as Error).message}`));
  }
}
