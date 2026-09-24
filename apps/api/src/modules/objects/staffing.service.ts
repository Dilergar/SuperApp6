import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OBJECTS_ERROR_CODES,
  PAYABLE_RATE_TYPES,
  SOURCE_LOCALE,
  type AssignToStaffingInput,
  type CloseAssignmentInput,
  type CreateStaffingPositionInput,
  type ObjectCapsDto,
  type PlannedPayrollRowDto,
  type SetRateInput,
  type StaffRateDto,
  type StaffingRowDto,
  type StaffingTableDto,
  type UpdateStaffingAssignmentInput,
  type UpdateStaffingPositionInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { ChatterService } from '../../core/chatter/chatter.service';
import { StaffService } from '../staff/staff.service';
import { HrService } from '../hr/hr.service';
import {
  activeAssignmentWhere,
  assignmentToday,
  isAssignmentActiveOn,
  isAssignmentOverlapError,
} from '../../shared/utils/assignment-window';
import { ObjectsService } from './objects.service';
import { ObjectsJobs } from './objects.jobs';
import { addDays, utcToLocalDate } from './shift-time';
import { VisibilityService, markShaped, type ShapeInput } from '../../core/visibility/visibility.service';

type Tx = Prisma.TransactionClient;

interface RateRow {
  id: string;
  rateType: string;
  amount: bigint;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
  createdAt: Date;
}

function dateStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function dayOf(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Последний день месяца периода YYYY-MM */
function periodBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

/**
 * Штатное расписание объекта: план ставок и людей.
 *
 * Штатная ЕДИНИЦА (должность × объект) существует и вакантной — на этом держится
 * план затрат. Назначение датировано, ставки версионируются. Деньги строк — поля типа
 * `objects.staffing` движка видимости (core/visibility): владелец/админ, руководитель объекта,
 * держатель гранта «видит деньги», руководитель человека и сам человек (своя ставка); прочим —
 * маркер «скрыто». Итог плана затрат — агрегат: только при ПОЛНОМ праве на деньги объекта.
 * Поля, которых зритель не увидит ни в одной строке, из БД не читаются вовсе.
 */
@Injectable()
export class StaffingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatter: ChatterService,
    private readonly objects: ObjectsService,
    private readonly staff: StaffService,
    private readonly hr: HrService,
    private readonly jobs: ObjectsJobs,
    private readonly i18n: I18nService,
    private readonly visibility: VisibilityService,
  ) {}

  // ============================================================
  // Таблица
  // ============================================================

  async table(
    userId: string,
    workspaceId: string,
    branchId: string,
    period: string,
  ): Promise<StaffingTableDto> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    const { from, to } = periodBounds(period);

    const units = await this.db.staffingPosition.findMany({
      where: { workspaceId, branchId, archivedAt: null },
      include: { position: { select: { name: true, glyph: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    // Назначения объекта ЦЕЛИКОМ, без окна периода: в строки идут те, что действуют
    // или закрылись в периоде, а «вакантно с …» считается по всей хронике единицы —
    // закрытое в прошлом году назначение и есть причина сегодняшней вакансии.
    // Привязанные к единице и «исторические» без неё — последние подцепляем к
    // единице той же должности, иначе человек пропал бы из штатки, хотя работает.
    const history = await this.db.staffAssignment.findMany({
      where: { workspaceId, branchId },
      include: { user: { select: { firstName: true, lastName: true, avatar: true } } },
      orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
    });
    const assignments = history.filter((a) => !a.endsOn || dateStr(a.endsOn)! >= from);

    const assignmentIds = assignments.map((a) => a.id);
    const unitIds = units.map((u) => u.id);
    const viewer = this.visibility.viewer('api', { workspaceId });
    const readable = await this.visibility.readableFields(viewer, 'objects.staffing', workspaceId);
    const needRates = readable.has('plannedRate') || readable.has('actualRate') || readable.has('plannedCost');
    const needEmployment = readable.has('officialSalary') || readable.has('employment');
    const [rates, employments, shiftStats] = await Promise.all([
      needRates
        ? this.db.staffRate.findMany({
            where: {
              workspaceId,
              OR: [
                ...(assignmentIds.length ? [{ assignmentId: { in: assignmentIds } }] : []),
                ...(unitIds.length ? [{ staffingPositionId: { in: unitIds } }] : []),
              ],
            },
            orderBy: { effectiveFrom: 'desc' },
          })
        : Promise.resolve([]),
      needEmployment
        ? this.hr.employmentSnapshotsFor(workspaceId, [...new Set(assignments.map((a) => a.userId))])
        : Promise.resolve(new Map()),
      this.shiftStats(workspaceId, branchId, from, to),
    ]);

    const rateByAssignment = new Map<string, RateRow>();
    const rateByUnit = new Map<string, RateRow>();
    for (const r of rates) {
      // Актуальная на КОНЕЦ периода версия (список уже отсортирован по убыванию).
      if (dateStr(r.effectiveFrom)! > to) continue;
      if (r.effectiveTo && dateStr(r.effectiveTo)! < from) continue;
      if (r.assignmentId && !rateByAssignment.has(r.assignmentId)) rateByAssignment.set(r.assignmentId, r);
      if (r.staffingPositionId && !rateByUnit.has(r.staffingPositionId)) rateByUnit.set(r.staffingPositionId, r);
    }

    const unitOfPosition = new Map<string, string>();
    for (const u of units) unitOfPosition.set(u.positionId, u.id);
    const groupByUnit = (list: typeof history) => {
      const map = new Map<string, typeof history>();
      for (const a of list) {
        const unitId = a.staffingPositionId ?? unitOfPosition.get(a.positionId);
        if (!unitId) continue;
        const bucket = map.get(unitId) ?? [];
        bucket.push(a);
        map.set(unitId, bucket);
      }
      return map;
    };
    const byUnit = groupByUnit(assignments);
    const historyByUnit = groupByUnit(history);

    const rows: StaffingRowDto[] = [];
    // Сырые деньги строки — на вход проекции (одна на таблицу), наружу только решения движка
    const money: ShapeInput[] = [];
    let plannedCost = 0n;
    for (const u of units) {
      const people = byUnit.get(u.id) ?? [];
      const active = people.filter((a) => isAssignmentActiveOn(a, to));
      const filled = active.reduce((sum, a) => sum + (a.rateShare ?? 1), 0);
      const plannedRate = rateByUnit.get(u.id) ?? null;

      const makeRow = (a: (typeof people)[number] | null, vacantSince?: string): StaffingRowDto => {
        const shifts = a ? (shiftStats.byUser.get(a.userId) ?? EMPTY_SHIFTS) : (shiftStats.open ?? EMPTY_SHIFTS);
        const actual = a ? (rateByAssignment.get(a.id) ?? null) : null;
        const emp = a ? (employments.get(a.userId) ?? [])[0] : undefined;
        const row: StaffingRowDto = {
          staffingPositionId: u.id,
          positionId: u.positionId,
          positionName: u.position.name,
          glyph: u.position.glyph,
          headcount: u.headcount,
          filled,
          note: u.note,
          assignment: a
            ? {
                id: a.id,
                userId: a.userId,
                userName:
                  [a.user?.lastName, a.user?.firstName].filter(Boolean).join(' ') ||
                  this.i18n.translate('common.labels.someone'),
                userAvatar: a.user?.avatar ?? null,
                startsOn: dateStr(a.startsOn),
                endsOn: dateStr(a.endsOn),
                rateShare: a.rateShare ?? 1,
                status: a.status,
                active: isAssignmentActiveOn(a, to),
              }
            : null,
          schedule: null,
          shifts,
        };
        if (!a && vacantSince) row.vacantSince = vacantSince;
        money.push({
          ref: { recordId: a?.id ?? u.id, subjectId: a?.userId ?? null, workspaceId, branchId },
          values: {
            ...(needRates
              ? { plannedRate: plannedRate ? this.serializeRate(plannedRate) : null, actualRate: actual ? this.serializeRate(actual) : null }
              : {}),
            ...(needEmployment
              ? {
                  officialSalary:
                    emp?.salaryAmount != null ? { amount: String(emp.salaryAmount), currency: emp.salaryCurrency } : null,
                  employment: emp
                    ? {
                        status: emp.status as 'draft' | 'active' | 'terminated',
                        contractType: emp.contractType,
                        workRate: emp.workRate,
                        legalEntityName: emp.legalEntityName,
                      }
                    : null,
                }
              : {}),
          },
        });
        return row;
      };

      for (const a of people) rows.push(makeRow(a));
      // Вакансии — тоже СТРОКИ: план затрат считает незанятые ставки.
      const vacancies = Math.max(0, u.headcount - Math.ceil(filled));
      const since = this.vacantSince(u, branch.timeZone, historyByUnit.get(u.id) ?? [], to, vacancies);
      for (let i = 0; i < vacancies; i += 1) rows.push(makeRow(null, since[i]));

      if (needRates) {
        plannedCost += this.rowsCost(u, plannedRate, rateByAssignment, people, to);
      }
    }

    // Деньги строк — глазами зрителя (Guarded: значение / маска / скрыто)
    const shaped = await this.visibility.shape(viewer, 'objects.staffing', money);
    rows.forEach((row, i) => {
      const v = shaped[i]!;
      if ('plannedRate' in v) row.plannedRate = v.plannedRate as StaffingRowDto['plannedRate'];
      if ('actualRate' in v) row.actualRate = v.actualRate as StaffingRowDto['actualRate'];
      if ('officialSalary' in v) row.officialSalary = v.officialSalary as StaffingRowDto['officialSalary'];
      if ('employment' in v) row.employment = v.employment as StaffingRowDto['employment'];
      markShaped(row);
    });
    // Итог — агрегат по деньгам ВСЕХ строк: только при полном праве на деньги объекта
    // (строки без субъекта — решение по объекту: руководитель, «видит деньги», владелец/админ)
    const [agg] = needRates
      ? await this.visibility.shape(viewer, 'objects.staffing', [
          { ref: { recordId: branchId, subjectId: null, workspaceId, branchId }, values: { plannedCost: String(plannedCost) } },
        ])
      : [null];
    const moneyFull = !!agg && typeof agg.plannedCost === 'string';

    const table: StaffingTableDto = {
      period,
      branchId,
      branchName: branch.name,
      // `payrollView` таблицы = зритель видит деньги объекта целиком (колонки и итоги);
      // руководитель человека без него видит деньги только своих строк
      caps: { ...caps, payrollView: moneyFull },
      rows,
    };
    if (moneyFull) {
      table.totals = {
        plannedCost: String(plannedCost),
        currency: 'KZT',
        headcount: units.reduce((s, u) => s + u.headcount, 0),
        filled: rows.filter((r) => r.assignment?.active).length,
      };
    }
    return table;
  }

  /**
   * «Вакантно с …» для каждой из `count` вакансий единицы. k-я вакансия (k от 1,
   * первая — самая давняя) пустует с даты, начиная с которой занятость единицы ни
   * разу не поднималась выше `headcount − k` вплоть до конца периода. Хроника — по
   * ВСЕМ назначениям единицы, включая закрытые до периода. Провала не нашлось — с
   * создания единицы (раньше неё вакансии быть не могло, даже если история
   * должности старше). Штат считается постоянным: история headcount не хранится.
   */
  private vacantSince(
    unit: { headcount: number; createdAt: Date },
    timeZone: string,
    history: Array<Parameters<typeof isAssignmentActiveOn>[0] & { rateShare: number | null }>,
    to: string,
    count: number,
  ): string[] {
    if (count === 0) return [];
    const created = utcToLocalDate(timeZone, unit.createdAt);
    // Даты, в которые состав меняется: начало назначения и день ПОСЛЕ его конца
    const marks = new Set<string>([created]);
    for (const a of history) {
      const s = a.startsOn ? dateStr(new Date(a.startsOn)) : null;
      if (s && s <= to) marks.add(s);
      const e = a.endsOn ? dateStr(new Date(a.endsOn)) : null;
      if (e && addDays(e, 1) <= to) marks.add(addDays(e, 1));
    }
    const bounds = [...marks].filter((d) => d <= to).sort().reverse(); // от поздних к ранним
    const vacantOn = (d: string) =>
      unit.headcount -
      Math.ceil(history.filter((a) => isAssignmentActiveOn(a, d)).reduce((sum, a) => sum + (a.rateShare ?? 1), 0));
    const result: string[] = [];
    for (let k = 1; k <= count; k += 1) {
      let since = to;
      for (const d of bounds) {
        if (vacantOn(d) < k) break;
        since = d;
      }
      result.push(since < created ? created : since);
    }
    return result;
  }

  // ============================================================
  // Штатные единицы
  // ============================================================

  async createUnit(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: CreateStaffingPositionInput,
  ): Promise<StaffingTableDto> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertManage(caps);
    const position = await this.db.staffPosition.findFirst({
      where: { id: dto.positionId, workspaceId },
      select: { id: true, name: true },
    });
    if (!position) throw badRequest('objects.positionNotFound');
    await this.assertTemplateOwned(workspaceId, branchId, dto.shiftTemplateId);

    await this.db
      .$transaction(async (tx) => {
        const unit = await tx.staffingPosition.create({
          data: {
            workspaceId,
            branchId,
            positionId: dto.positionId,
            headcount: dto.headcount ?? 1,
            shiftTemplateId: dto.shiftTemplateId ?? null,
            note: dto.note ?? null,
            createdById: userId,
          },
        });
        if (dto.plannedRate) {
          await this.writeRate(tx, workspaceId, userId, { staffingPositionId: unit.id }, dto.plannedRate);
        }
        await this.chatter.log(tx, {
          refType: 'branch',
          refId: branchId,
          workspaceId,
          actorId: userId,
          typeKey: 'staffing.unit_created',
          payload: { positionName: position.name, headcount: unit.headcount },
        });
      })
      .catch((e: unknown) => this.rethrowUnit(e));

    return this.table(userId, workspaceId, branchId, utcToLocalDate(branch.timeZone, new Date()).slice(0, 7));
  }

  async updateUnit(
    userId: string,
    workspaceId: string,
    unitId: string,
    dto: UpdateStaffingPositionInput,
  ): Promise<void> {
    const unit = await this.unitOrThrow(workspaceId, unitId);
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, unit.branchId);
    this.objects.assertManage(caps);
    await this.assertTemplateOwned(workspaceId, unit.branchId, dto.shiftTemplateId);
    await this.db.$transaction(async (tx) => {
      const next = await tx.staffingPosition.update({
        where: { id: unitId },
        data: {
          ...(dto.headcount !== undefined ? { headcount: dto.headcount } : {}),
          ...(dto.shiftTemplateId !== undefined ? { shiftTemplateId: dto.shiftTemplateId } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
        include: { position: { select: { name: true } } },
      });
      if (dto.headcount !== undefined && dto.headcount !== unit.headcount) {
        await this.chatter.log(tx, {
          refType: 'branch',
          refId: unit.branchId,
          workspaceId,
          actorId: userId,
          typeKey: 'staffing.unit_updated',
          changes: [
            {
              field: 'headcount',
              // Снимок подписи ложится в БД — берём его в языке ИСТОЧНИКА.
              label: this.i18n.translateFor(SOURCE_LOCALE, 'chatter.fields.staffing.headcount'),
              from: String(unit.headcount),
              to: String(dto.headcount),
            },
          ],
          payload: { positionName: next.position.name },
        });
      }
    });
  }

  /** Убрать единицу из штатки: архив, а не удаление (на неё ссылаются ставки). */
  async archiveUnit(userId: string, workspaceId: string, unitId: string): Promise<void> {
    const unit = await this.unitOrThrow(workspaceId, unitId);
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, unit.branchId);
    this.objects.assertManage(caps);
    // Сравниваем по ДАТЕ: `ends_on` — колонка DATE (полночь UTC), и `new Date()`
    // уже больше неё — единица архивировалась под человеком, чей последний день сегодня.
    const busy = await this.db.staffAssignment.count({
      where: { staffingPositionId: unitId, ...activeAssignmentWhere() },
    });
    if (busy > 0) {
      throw conflict('objects.unitHasAssignments', undefined, { code: OBJECTS_ERROR_CODES.objectInUse });
    }
    await this.db.$transaction(async (tx) => {
      const next = await tx.staffingPosition.update({
        where: { id: unitId },
        data: { archivedAt: new Date() },
        include: { position: { select: { name: true } } },
      });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: unit.branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'staffing.unit_archived',
        payload: { positionName: next.position.name },
      });
    });
  }

  // ============================================================
  // Назначения
  // ============================================================

  async assign(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: AssignToStaffingInput,
  ): Promise<StaffingTableDto> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertManage(caps);
    const branchTimeZone = branch.timeZone;
    const unit = await this.unitOrThrow(workspaceId, dto.staffingPositionId);
    if (unit.branchId !== branchId) throw badRequest('objects.unitOtherSite');
    // На архивную единицу назначать нельзя: в таблице её нет, и человек либо
    // проваливается в чужую строку, либо исчезает из штатки, продолжая работать.
    if (unit.archivedAt) {
      throw conflict('objects.unitArchived', undefined, { code: OBJECTS_ERROR_CODES.objectInUse });
    }

    // Плановая ставка единицы — предзаполнение фактической (её можно переопределить).
    // Ранг субъекта уважается и здесь: `assignPositionSystem` прав не проверяет,
    // а управляющий объектом не должен трогать назначения владельца организации.
    await this.staff.assertRankOver(userId, workspaceId, dto.userId);

    const planned = await this.db.staffRate.findFirst({
      where: { staffingPositionId: unit.id, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    const startsOn = dto.startsOn ?? utcToLocalDate(branchTimeZone, new Date());
    const rate = dto.rate ?? (planned ? { rateType: planned.rateType, amount: String(planned.amount), currency: planned.currency } : null);

    await this.staff.assignPositionSystem(
      userId,
      workspaceId,
      dto.userId,
      {
        positionId: unit.positionId,
        branchId,
        startsOn,
        rateShare: dto.rateShare ?? 1,
        staffingPositionId: unit.id,
      },
      // Ставка и назначение появляются ОДНИМ коммитом: «назначили, а платить забыли»
      // — состояние, которого быть не должно.
      async (tx, assignmentId) => {
        if (rate) {
          await this.writeRate(tx, workspaceId, userId, { assignmentId }, { ...rate, effectiveFrom: startsOn });
        }
        // Наступление даты событием не приходит: ставим пересборку прав на полночь
        // в поясе объекта — В ТОЙ ЖЕ транзакции (правило движка джобов).
        await this.jobs.enqueueRollover(tx, workspaceId, assignmentId, startsOn, branchTimeZone);
        await this.chatter.log(tx, {
          refType: 'branch',
          refId: branchId,
          workspaceId,
          actorId: userId,
          typeKey: 'staffing.assigned',
          payload: { positionName: unit.positionName, startsOnIso: startsOn, targetUserId: dto.userId },
        });
      },
    );

    return this.table(userId, workspaceId, branchId, startsOn.slice(0, 7));
  }

  async updateAssignment(
    userId: string,
    workspaceId: string,
    assignmentId: string,
    dto: UpdateStaffingAssignmentInput,
  ): Promise<void> {
    const a = await this.assignmentOrThrow(workspaceId, assignmentId);
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, a.branchId);
    this.objects.assertManage(caps);
    await this.db
      .$transaction(async (tx) => {
        await tx.staffAssignment.update({
          where: { id: assignmentId },
          data: {
            ...(dto.startsOn !== undefined ? { startsOn: dto.startsOn ? dayOf(dto.startsOn) : null } : {}),
            ...(dto.endsOn !== undefined ? { endsOn: dto.endsOn ? dayOf(dto.endsOn) : null } : {}),
            ...(dto.rateShare !== undefined ? { rateShare: dto.rateShare } : {}),
          },
        });
        // Границы окна сдвинулись — пересборка прав на КАЖДУЮ новую границу.
        for (const day of [dto.startsOn, dto.endsOn]) {
          if (day) await this.jobs.enqueueRollover(tx, workspaceId, assignmentId, day, branch.timeZone);
        }
      })
      .catch((e: unknown) => this.rethrowOverlap(e));
    await this.staff.afterStructureChanged(workspaceId);
  }

  async closeAssignment(
    userId: string,
    workspaceId: string,
    assignmentId: string,
    dto: CloseAssignmentInput,
  ): Promise<void> {
    const a = await this.assignmentOrThrow(workspaceId, assignmentId);
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, a.branchId);
    this.objects.assertManage(caps);
    // В БД стоит CHECK (ends_on >= starts_on), и его нарушение Prisma отдаёт сырой
    // ошибкой: она не разобрана в общем фильтре и превращалась в 500.
    await this.staff.assertRankOver(userId, workspaceId, a.userId);
    const startsOnStr = dateStr(a.startsOn);
    if (startsOnStr && dto.endsOn < startsOnStr) {
      throw badRequest('objects.closeBeforeStart', { startsOn: startsOnStr });
    }
    await this.db.$transaction(async (tx) => {
      await tx.staffAssignment.update({
        where: { id: assignmentId },
        data: { endsOn: dayOf(dto.endsOn), isPrimary: false },
      });
      // Истечение даты события не рождает — пересборка прав на полночь ПОСЛЕ конца:
      // в сам последний день назначение ещё действует, и права снимать рано.
      await this.jobs.enqueueRollover(tx, workspaceId, assignmentId, addDays(dto.endsOn, 1), branch.timeZone);
      // Поднимаем следующее ДЕЙСТВУЮЩЕЕ назначение основным, только если закрывали
      // именно основное: безусловное повышение ломало партиальный уникум
      // «одно основное на человека» и отдавало 409 на ровном месте.
      if (a.isPrimary) {
        const next = await tx.staffAssignment.findFirst({
          where: {
            workspaceId,
            userId: a.userId,
            id: { not: assignmentId },
            ...activeAssignmentWhere(dto.endsOn),
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) await tx.staffAssignment.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: a.branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'staffing.closed',
        payload: { positionName: a.positionName, endsOnIso: dto.endsOn, targetUserId: a.userId },
      });
    });
    await this.staff.afterStructureChanged(workspaceId);
  }

  // ============================================================
  // Ставки
  // ============================================================

  async setAssignmentRate(
    userId: string,
    workspaceId: string,
    assignmentId: string,
    dto: SetRateInput,
  ): Promise<StaffRateDto> {
    const a = await this.assignmentOrThrow(workspaceId, assignmentId);
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, a.branchId);
    this.objects.assertManage(caps);
    if (!caps.payrollView) throw forbidden('objects.rateNeedsPayroll');
    await this.assertMoneyWritable(workspaceId, { recordId: a.id, subjectId: a.userId, branchId: a.branchId }, 'actualRate');
    // Уникум «одна версия на дату» отдаёт P2002 — без обёртки клиент получал
    // сырой текст Prisma и был вынужден ветвиться по строке.
    return this.db
      .$transaction(async (tx) => {
      const row = await this.writeRate(tx, workspaceId, userId, { assignmentId }, dto);
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: a.branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'staffing.rate_set',
        payload: {
          rateLabelKey: `objects.rateType.${dto.rateType}`,
          effectiveFromIso: dateStr(row.effectiveFrom),
          targetUserId: a.userId,
        },
      });
      return this.serializeRate(row);
      })
      .catch((e: unknown) => this.rethrowOverlap(e));
  }

  async setUnitRate(
    userId: string,
    workspaceId: string,
    unitId: string,
    dto: SetRateInput,
  ): Promise<StaffRateDto> {
    const unit = await this.unitOrThrow(workspaceId, unitId);
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, unit.branchId);
    this.objects.assertManage(caps);
    if (!caps.payrollView) throw forbidden('objects.rateNeedsPayroll');
    await this.assertMoneyWritable(workspaceId, { recordId: unitId, subjectId: null, branchId: unit.branchId }, 'plannedRate');
    return this.db
      .$transaction(async (tx) => {
      const row = await this.writeRate(tx, workspaceId, userId, { staffingPositionId: unitId }, dto);
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: unit.branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'staffing.rate_set',
        payload: { rateLabelKey: `objects.rateType.${dto.rateType}`, effectiveFromIso: dateStr(row.effectiveFrom) },
      });
      return this.serializeRate(row);
      })
      .catch((e: unknown) => this.rethrowOverlap(e));
  }

  async listAssignmentRates(
    userId: string,
    workspaceId: string,
    assignmentId: string,
  ): Promise<StaffRateDto[]> {
    const a = await this.assignmentOrThrow(workspaceId, assignmentId);
    await this.objects.getOrThrow(userId, workspaceId, a.branchId);
    // История ставок человека — то же поле `actualRate`: видно тому, кто видит его ставку
    // (руководитель объекта, «видит деньги», руководитель человека, сам)
    const [probe] = await this.visibility.shape(this.visibility.viewer('api', { workspaceId }), 'objects.staffing', [
      { ref: { recordId: a.id, subjectId: a.userId, workspaceId, branchId: a.branchId }, values: { actualRate: '__probe__' } },
    ]);
    if (probe!.actualRate !== '__probe__') return [];
    const rows = await this.db.staffRate.findMany({
      where: { assignmentId },
      orderBy: { effectiveFrom: 'desc' },
    });
    return rows.map((r) => this.serializeRate(r));
  }

  /** Нельзя записать деньги, которых не видишь (W): правила организации сильнее гранта объекта. */
  private async assertMoneyWritable(
    workspaceId: string,
    ref: { recordId: string; subjectId: string | null; branchId: string },
    field: 'actualRate' | 'plannedRate',
  ): Promise<void> {
    await this.visibility.assertWritable(this.visibility.viewer('api', { workspaceId }), 'objects.staffing', { ...ref, workspaceId }, { [field]: 1 });
  }

  // ============================================================
  // Порт плана затрат (читают будущие Финансы)
  // ============================================================

  async getPlannedPayroll(
    workspaceId: string,
    q: { branchId?: string; from: string; to: string },
  ): Promise<{ rows: PlannedPayrollRowDto[]; totals: { plannedCost: string; currency: string } }> {
    const branchIds = q.branchId
      ? (
          await this.db.staffBranch.findMany({
            where: { workspaceId, OR: [{ id: q.branchId }, { ancestorIds: { has: q.branchId } }] },
            select: { id: true },
          })
        ).map((b) => b.id)
      : undefined;

    const units = await this.db.staffingPosition.findMany({
      where: { workspaceId, archivedAt: null, ...(branchIds ? { branchId: { in: branchIds } } : {}) },
    });
    const unitIds = units.map((u) => u.id);
    const [assignments, rates, shifts] = await Promise.all([
      this.db.staffAssignment.findMany({
        where: {
          workspaceId,
          ...(branchIds ? { branchId: { in: branchIds } } : {}),
          // Окно назначения обязано ПЕРЕСЕКАТЬСЯ с периодом плана: раньше не было
          // верхней границы, и человек, принятый на будущий год, попадал в план
          // текущего месяца целым окладом.
          AND: [
            { OR: [{ endsOn: null }, { endsOn: { gte: dayOf(q.from) } }] },
            { OR: [{ startsOn: null }, { startsOn: { lte: dayOf(q.to) } }] },
          ],
        },
      }),
      // Ставки скоуплены и целью, и периодом: ветка «любая ставка любого
      // назначения» тянула ВСЕ версии ставок всех людей сети.
      this.db.staffRate.findMany({
        where: {
          workspaceId,
          effectiveFrom: { lte: dayOf(q.to) },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayOf(q.from) } }],
          ...(branchIds
            ? {
                OR: [
                  { staffingPositionId: { in: unitIds.length ? unitIds : ['-'] } },
                  { assignment: { branchId: { in: branchIds } } },
                ],
              }
            : {}),
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.db.shift.findMany({
        where: {
          workspaceId,
          ...(branchIds ? { branchId: { in: branchIds } } : {}),
          status: { not: 'cancelled' },
          localDate: { gte: dayOf(q.from), lte: dayOf(q.to) },
        },
        select: { staffingPositionId: true, assignmentId: true, startsAt: true, endsAt: true, breakMin: true },
      }),
    ]);

    // Индекс по цели вместо перебора всего списка на каждую строку плана.
    const rateByUnit = new Map<string, (typeof rates)[number]>();
    const rateByAssignment = new Map<string, (typeof rates)[number]>();
    for (const r of rates) {
      if (dateStr(r.effectiveFrom)! > q.to) continue;
      if (r.effectiveTo && dateStr(r.effectiveTo)! < q.from) continue;
      if (r.staffingPositionId && !rateByUnit.has(r.staffingPositionId)) rateByUnit.set(r.staffingPositionId, r);
      if (r.assignmentId && !rateByAssignment.has(r.assignmentId)) rateByAssignment.set(r.assignmentId, r);
    }

    const shiftAgg = new Map<string, { count: number; minutes: number }>();
    for (const s of shifts) {
      const key = s.assignmentId ?? `unit:${s.staffingPositionId ?? ''}`;
      const cur = shiftAgg.get(key) ?? { count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 60000 - (s.breakMin ?? 0));
      shiftAgg.set(key, cur);
    }

    const rows: PlannedPayrollRowDto[] = [];
    let total = 0n;
    for (const u of units) {
      const people = assignments.filter((a) => a.staffingPositionId === u.id);
      const plannedRate = rateByUnit.get(u.id) ?? null;
      const emit = (a: (typeof assignments)[number] | null) => {
        const rate = a ? (rateByAssignment.get(a.id) ?? plannedRate) : plannedRate;
        if (!rate) return;
        if (!(PAYABLE_RATE_TYPES as readonly string[]).includes(rate.rateType)) return;
        const agg = shiftAgg.get(a ? a.id : `unit:${u.id}`) ?? { count: 0, minutes: 0 };
        const share = a?.rateShare ?? 1;
        const cost = this.costOf(rate.rateType, rate.amount, share, agg.count, agg.minutes);
        total += cost;
        rows.push({
          branchId: u.branchId,
          staffingPositionId: u.id,
          positionId: u.positionId,
          assignmentId: a?.id ?? null,
          userId: a?.userId ?? null,
          rateType: rate.rateType as PlannedPayrollRowDto['rateType'],
          amount: String(rate.amount),
          rateShare: share,
          plannedShifts: agg.count,
          plannedMin: agg.minutes,
          plannedCost: String(cost),
        });
      };
      for (const a of people) emit(a);
      // Вакансии считаем ДОЛЯМИ ставок (как в таблице штатки): два человека на
      // полставки закрывают одну единицу, а не две.
      const filled = people.reduce((sum, a) => sum + (a.rateShare ?? 1), 0);
      const vacancies = Math.max(0, u.headcount - Math.ceil(filled));
      for (let i = 0; i < vacancies; i += 1) emit(null);
    }
    return { rows, totals: { plannedCost: String(total), currency: 'KZT' } };
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /**
   * Записать версию ставки, закрыв предыдущую днём раньше (SCD2, append-only).
   * Обе операции — В ОДНОЙ транзакции: «две открытые ставки» это неверный расчёт.
   */
  private async writeRate(
    tx: Tx,
    workspaceId: string,
    userId: string,
    target: { assignmentId?: string; staffingPositionId?: string },
    dto: { rateType: string; amount: string; currency?: string; effectiveFrom?: string; note?: string | null },
  ) {
    // Дата по умолчанию — «сегодня» платформы (пояс объекта прокидывает вызывающий
    // через effectiveFrom), но не UTC-дата сервера.
    const from = dto.effectiveFrom ?? assignmentToday();
    const where = target.assignmentId
      ? { assignmentId: target.assignmentId }
      : { staffingPositionId: target.staffingPositionId! };
    const prevDay = new Date(dayOf(from).getTime() - 86400000);
    // Предыдущая открытая версия закрывается днём раньше новой.
    await tx.staffRate.updateMany({
      where: { ...where, effectiveTo: null, effectiveFrom: { lt: dayOf(from) } },
      data: { effectiveTo: prevDay },
    });
    // Версия ЗАДНИМ ЧИСЛОМ обязана закрыться следующей: иначе в истории две
    // «бессрочные» ставки, и ответ на «сколько платили в марте» держался бы
    // только на удачном порядке сортировки.
    const next = await tx.staffRate.findFirst({
      where: { ...where, effectiveFrom: { gt: dayOf(from) } },
      orderBy: { effectiveFrom: 'asc' },
      select: { effectiveFrom: true },
    });
    const effectiveTo = next ? new Date(next.effectiveFrom.getTime() - 86400000) : null;
    return tx.staffRate.create({
      data: {
        workspaceId,
        ...where,
        rateType: dto.rateType,
        amount: BigInt(dto.amount),
        currency: dto.currency ?? 'KZT',
        effectiveFrom: dayOf(from),
        effectiveTo,
        note: dto.note ?? null,
        createdById: userId,
      },
    });
  }

  private serializeRate(r: RateRow): StaffRateDto {
    return {
      id: r.id,
      rateType: r.rateType as StaffRateDto['rateType'],
      amount: String(r.amount),
      currency: r.currency,
      effectiveFrom: dateStr(r.effectiveFrom)!,
      effectiveTo: dateStr(r.effectiveTo),
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Стоимость периода по типу ставки (revenue_share не считается — только хранится). */
  private costOf(
    rateType: string,
    amount: bigint,
    share: number,
    shifts: number,
    minutes: number,
  ): bigint {
    const scale = (v: bigint, k: number) => BigInt(Math.round(Number(v) * k));
    if (rateType === 'monthly') return scale(amount, share);
    if (rateType === 'per_shift') return scale(amount, share * shifts);
    if (rateType === 'hourly') return scale(amount, (share * minutes) / 60);
    return 0n;
  }

  private rowsCost(
    unit: { id: string; headcount: number },
    plannedRate: RateRow | null,
    rateByAssignment: Map<string, RateRow>,
    people: { id: string; rateShare: number | null; endsOn: Date | null; startsOn: Date | null }[],
    at: string,
  ): bigint {
    let sum = 0n;
    const active = people.filter((a) => isAssignmentActiveOn(a, at));
    for (const a of active) {
      const rate = rateByAssignment.get(a.id) ?? plannedRate;
      if (rate) sum += this.costOf(rate.rateType, rate.amount, a.rateShare ?? 1, 0, 0);
    }
    const vacancies = Math.max(0, unit.headcount - active.length);
    if (plannedRate) for (let i = 0; i < vacancies; i += 1) sum += this.costOf(plannedRate.rateType, plannedRate.amount, 1, 0, 0);
    return sum;
  }

  /** План/факт смен объекта за период — счётчики строк штатки. */
  private async shiftStats(
    workspaceId: string,
    branchId: string,
    from: string,
    to: string,
  ): Promise<{ byUser: Map<string, StaffingRowDto['shifts']>; open: StaffingRowDto['shifts'] }> {
    const byUser = new Map<string, StaffingRowDto['shifts']>();
    const open = { ...EMPTY_SHIFTS };
    const [shifts, attendance] = await Promise.all([
      this.db.shift.findMany({
        where: {
          workspaceId,
          branchId,
          status: { not: 'cancelled' },
          localDate: { gte: dayOf(from), lte: dayOf(to) },
        },
        select: { userId: true },
      }),
      this.db.shiftAttendance.findMany({
        where: { workspaceId, branchId, localDate: { gte: dayOf(from), lte: dayOf(to) } },
        select: { userId: true, outcome: true },
      }),
    ]);
    for (const s of shifts) {
      if (!s.userId) {
        open.planned += 1;
        continue;
      }
      const cur = byUser.get(s.userId) ?? { ...EMPTY_SHIFTS };
      cur.planned += 1;
      byUser.set(s.userId, cur);
    }
    for (const a of attendance) {
      const cur = byUser.get(a.userId) ?? { ...EMPTY_SHIFTS };
      if (a.outcome === 'worked') cur.worked += 1;
      else if (a.outcome === 'late') cur.late += 1;
      else if (a.outcome === 'absent') cur.absent += 1;
      byUser.set(a.userId, cur);
    }
    return { byUser, open };
  }

  private async unitOrThrow(workspaceId: string, unitId: string) {
    const unit = await this.db.staffingPosition.findFirst({
      where: { id: unitId, workspaceId },
      include: { position: { select: { name: true } } },
    });
    if (!unit) throw notFound('objects.unitNotFound');
    return { ...unit, positionName: unit.position.name };
  }

  private async assignmentOrThrow(workspaceId: string, assignmentId: string) {
    const a = await this.db.staffAssignment.findFirst({
      where: { id: assignmentId, workspaceId },
      include: { position: { select: { name: true } } },
    });
    if (!a) throw notFound('objects.assignmentNotFound');
    return { ...a, positionName: a.position.name };
  }

  private rethrowUnit(e: unknown): never {
    if ((e as { code?: string })?.code === 'P2002') {
      throw conflict('objects.unitDuplicate', undefined, { code: OBJECTS_ERROR_CODES.staffingUnitDuplicate });
    }
    throw e as Error;
  }

  /**
   * Шаблон смены у штатной единицы обязан быть СВОИМ: внешний ключ ведёт во всю
   * таблицу шаблонов без скоупа по организации.
   */
  private async assertTemplateOwned(
    workspaceId: string,
    branchId: string,
    templateId: string | null | undefined,
  ): Promise<void> {
    if (!templateId) return;
    const tpl = await this.db.shiftTemplate.findFirst({
      where: { id: templateId, workspaceId, archivedAt: null, OR: [{ branchId: null }, { branchId }] },
      select: { id: true },
    });
    if (!tpl) throw badRequest('objects.templateNotFound');
  }

  private rethrowOverlap(e: unknown): never {
    if (isAssignmentOverlapError(e)) {
      throw conflict('objects.assignmentOverlap', undefined, { code: OBJECTS_ERROR_CODES.assignmentOverlap });
    }
    if ((e as { code?: string })?.code === 'P2002') {
      throw conflict('objects.rateOverlap', undefined, { code: OBJECTS_ERROR_CODES.rateOverlap });
    }
    throw e as Error;
  }
}

const EMPTY_SHIFTS: StaffingRowDto['shifts'] = { planned: 0, worked: 0, late: 0, absent: 0 };

/** Права — публичный тип для контроллера (сужение полей считается один раз). */
export type StaffingCaps = ObjectCapsDto;
