import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OBJECTS_ERROR_CODES,
  OBJECTS_FULL_SCOPE_ROLES,
  OBJECT_LIMITS,
  type CreateShiftInput,
  type ObjectCapsDto,
  type PublishShiftsInput,
  type ShiftBoardDto,
  type ShiftDto,
  type ShiftPatternDto,
  type ShiftPatternInput,
  type ShiftTemplateDto,
  type ShiftTemplateInput,
  type UpdateShiftInput,
  type UpdateShiftTemplateInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isAssignmentActiveOn } from '../../shared/utils/assignment-window';
import { ObjectsService, type ObjectsScope, type BranchRow } from './objects.service';
import { SHIFTS_GENERATE_JOB } from './objects.job-types';
import {
  addDays,
  checkRest,
  expandPattern,
  localToUtc,
  utcToLocalDate,
  weekStartOf,
} from './shift-time';

type Tx = Prisma.TransactionClient;

function dayOf(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function dateStr(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * График смен объекта: шаблоны, ротации, ПЛАН (Shift).
 *
 * Экземпляр смены замораживает время в себе — правка шаблона план не трогает.
 * Черновик виден только тем, кто ведёт график; сотрудник видит ОПУБЛИКОВАННОЕ.
 * Правила объекта (межсменный отдых, максимум смены) — данные `scheduleSettings`;
 * нарушение → 409, обход `force` только с `branch.manage` и записью в хронику.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly objects: ObjectsService,
  ) {}

  // ============================================================
  // Шаблоны
  // ============================================================

  async listTemplates(
    userId: string,
    workspaceId: string,
    branchId?: string,
    known?: ObjectsScope,
  ): Promise<ShiftTemplateDto[]> {
    const scope = known ?? (await this.objects.scopeOf(userId, workspaceId));
    if (!scope.role || scope.role === 'contractor') throw new NotFoundException('Организация не найдена');
    // Шаблоны объекта видит тот, кто видит объект: иначе любой член организации
    // читал бы расписание чужой точки по одному лишь id в query.
    const branchCaps = branchId
      ? (await this.objects.getOrThrow(userId, workspaceId, branchId, scope)).caps
      : null;
    const rows = await this.db.shiftTemplate.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { startMin: 'asc' }],
    });
    // Общий шаблон организации правят только owner/admin, шаблон объекта — тот, кто
    // ведёт его график. Отдаём готовый флаг: клиент не должен угадывать это по роли.
    return rows.map((r) =>
      this.serializeTemplate(r, r.branchId === null ? scope.full : (branchCaps?.scheduleManage ?? scope.full)),
    );
  }

  async createTemplate(
    userId: string,
    workspaceId: string,
    dto: ShiftTemplateInput,
  ): Promise<ShiftTemplateDto> {
    await this.assertTemplateRight(userId, workspaceId, dto.branchId ?? null);
    const row = await this.db.shiftTemplate.create({
      data: {
        workspaceId,
        branchId: dto.branchId ?? null,
        name: dto.name,
        startMin: dto.startMin,
        durationMin: dto.durationMin,
        breakMin: dto.breakMin ?? 0,
        color: dto.color ?? null,
        glyph: dto.glyph ?? null,
        sortOrder: dto.sortOrder ?? 0,
        createdById: userId,
      },
    });
    return this.serializeTemplate(row, true);
  }

  async updateTemplate(
    userId: string,
    workspaceId: string,
    templateId: string,
    dto: UpdateShiftTemplateInput,
  ): Promise<ShiftTemplateDto> {
    const tpl = await this.db.shiftTemplate.findFirst({ where: { id: templateId, workspaceId } });
    if (!tpl) throw new NotFoundException('Шаблон не найден');
    await this.assertTemplateRight(userId, workspaceId, tpl.branchId);
    const row = await this.db.shiftTemplate.update({
      where: { id: templateId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.startMin !== undefined ? { startMin: dto.startMin } : {}),
        ...(dto.durationMin !== undefined ? { durationMin: dto.durationMin } : {}),
        ...(dto.breakMin !== undefined ? { breakMin: dto.breakMin } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.glyph !== undefined ? { glyph: dto.glyph } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
    return this.serializeTemplate(row, true);
  }

  async archiveTemplate(userId: string, workspaceId: string, templateId: string): Promise<void> {
    const tpl = await this.db.shiftTemplate.findFirst({ where: { id: templateId, workspaceId } });
    if (!tpl) throw new NotFoundException('Шаблон не найден');
    await this.assertTemplateRight(userId, workspaceId, tpl.branchId);
    // Архив, а не удаление: на шаблон ссылаются уже поставленные смены и ротации.
    await this.db.shiftTemplate.update({ where: { id: templateId }, data: { archivedAt: new Date() } });
  }

  // ============================================================
  // Ротации
  // ============================================================

  async listPatterns(userId: string, workspaceId: string, branchId: string): Promise<ShiftPatternDto[]> {
    await this.objects.getOrThrow(userId, workspaceId, branchId);
    const rows = await this.db.shiftPattern.findMany({
      where: { workspaceId, branchId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.serializePattern(r));
  }

  async createPattern(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: ShiftPatternInput,
  ): Promise<ShiftPatternDto> {
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertSchedule(caps);
    await this.assertCycleTemplates(workspaceId, dto.cycle);
    // Цель ротации обязана принадлежать ЭТОМУ объекту и этой организации: иначе
    // по чужому назначению генерировались бы смены, которые после публикации
    // уезжают постороннему человеку в его личный календарь.
    if (dto.assignmentId) {
      const target = await this.db.staffAssignment.findFirst({
        where: { id: dto.assignmentId, workspaceId, branchId },
        select: { id: true },
      });
      if (!target) throw new BadRequestException('Назначение не найдено в этом объекте');
    }
    if (dto.staffingPositionId) {
      const unit = await this.db.staffingPosition.findFirst({
        where: { id: dto.staffingPositionId, workspaceId, branchId, archivedAt: null },
        select: { id: true },
      });
      if (!unit) throw new BadRequestException('Штатная единица не найдена в этом объекте');
    }

    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.shiftPattern.create({
        data: {
          workspaceId,
          branchId,
          assignmentId: dto.assignmentId ?? null,
          staffingPositionId: dto.staffingPositionId ?? null,
          name: dto.name,
          anchorDate: dayOf(dto.anchorDate),
          cycle: dto.cycle,
          activeFrom: dayOf(dto.activeFrom),
          activeTo: dto.activeTo ? dayOf(dto.activeTo) : null,
          horizonDays: dto.horizonDays ?? OBJECT_LIMITS.horizonDays,
          createdById: userId,
        },
      });
      // Обязательный фон ставится В ТОЙ ЖЕ транзакции: если инстанс упадёт сразу
      // после создания ротации, смены всё равно будут порождены (джоб идемпотентен).
      await this.jobs.enqueue(tx, {
        type: SHIFTS_GENERATE_JOB,
        payload: { patternId: created.id, weekStart: ShiftsService.weekKey(dto.activeFrom) },
        uniqueKey: `sp:${created.id}:${ShiftsService.weekKey(dto.activeFrom)}`,
      });
      return created;
    });
    // Генерация — сразу (создатель ждёт увидеть смены), дальше её догоняет крон.
    await this.generateFromPattern(row.id);
    return this.serializePattern(row);
  }

  async archivePattern(userId: string, workspaceId: string, patternId: string): Promise<void> {
    const p = await this.db.shiftPattern.findFirst({ where: { id: patternId, workspaceId } });
    if (!p) throw new NotFoundException('Ротация не найдена');
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, p.branchId);
    this.objects.assertSchedule(caps);
    const today = utcToLocalDate(branch.timeZone, new Date());
    await this.db.$transaction(async (tx) => {
      await tx.shiftPattern.update({ where: { id: patternId }, data: { archivedAt: new Date() } });
      // Порождённые ЧЕРНОВИКИ будущего снимаем: опубликованные остаются — на них
      // люди уже рассчитывают. «Сегодня» — в поясе объекта.
      await tx.shift.deleteMany({
        where: { patternId, status: 'draft', localDate: { gte: dayOf(today) } },
      });
    });
  }

  /**
   * Догенерация по ротации из ручки. Право проверяется ЗДЕСЬ: `generateFromPattern`
   * — метод контракта `system*` (его зовут джоб и крон), прав он не проверяет.
   */
  async generate(userId: string, workspaceId: string, patternId: string): Promise<number> {
    const p = await this.db.shiftPattern.findFirst({ where: { id: patternId, workspaceId } });
    if (!p) throw new NotFoundException('Ротация не найдена');
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, p.branchId);
    this.objects.assertSchedule(caps);
    return this.generateFromPattern(patternId);
  }

  /**
   * Породить смены по ротации на горизонт. Идемпотентно: рукописный уникум
   * `shifts_pattern_slot_key` (pattern, localDate, slot) отвергает повтор.
   */
  async generateFromPattern(patternId: string): Promise<number> {
    const pattern = await this.db.shiftPattern.findUnique({
      where: { id: patternId },
      include: { assignment: true, staffingPosition: true },
    });
    if (!pattern || pattern.archivedAt) return 0;
    const branch = await this.db.staffBranch.findUnique({ where: { id: pattern.branchId } });
    if (!branch) return 0;

    // «Сегодня» — в поясе ОБЪЕКТА: у точки в Актау день наступает не тогда, когда
    // у сервера в UTC (в 02:00 по Алматы UTC-«сегодня» — это ещё вчера).
    const from = utcToLocalDate(branch.timeZone, new Date());
    const to = addDays(from, pattern.horizonDays);
    const slots = expandPattern(
      {
        anchorDate: dateStr(pattern.anchorDate)!,
        cycle: (pattern.cycle as (string | null)[]) ?? [],
        activeFrom: dateStr(pattern.activeFrom)!,
        activeTo: dateStr(pattern.activeTo),
      },
      from,
      to,
    );
    if (slots.length === 0) return 0;

    const templates = await this.db.shiftTemplate.findMany({
      where: { id: { in: [...new Set(slots.map((s) => s.templateId))] } },
    });
    const tplById = new Map(templates.map((t) => [t.id, t]));

    const positionId = pattern.assignment?.positionId ?? pattern.staffingPosition?.positionId;
    if (!positionId) return 0;
    const staffingPositionId = pattern.staffingPositionId ?? pattern.assignment?.staffingPositionId ?? null;

    let created = 0;
    for (const slot of slots) {
      const tpl = tplById.get(slot.templateId);
      if (!tpl) continue;
      // Ротация не переживает окончание назначения: уволенному 20-го числа смены
      // до конца горизонта не ставим.
      if (pattern.assignment && !isAssignmentActiveOn(pattern.assignment, slot.localDate)) continue;
      const startsAt = localToUtc(branch.timeZone, slot.localDate, tpl.startMin);
      const endsAt = new Date(startsAt.getTime() + tpl.durationMin * 60_000);
      try {
        await this.db.shift.create({
          data: {
            workspaceId: pattern.workspaceId,
            branchId: pattern.branchId,
            staffingPositionId,
            positionId,
            assignmentId: pattern.assignmentId,
            userId: pattern.assignment?.userId ?? null,
            localDate: dayOf(slot.localDate),
            startsAt,
            endsAt,
            breakMin: tpl.breakMin,
            templateId: tpl.id,
            patternId: pattern.id,
            patternSlot: slot.slot,
            status: 'draft',
            createdById: pattern.createdById,
          },
        });
        created += 1;
      } catch (e) {
        // P2002 — слот уже порождён (идемпотентность); 23P01 — человек уже занят
        // в это время другой сменой: такую ротация просто пропускает.
        const code = (e as { code?: string })?.code;
        const msg = (e as { message?: string })?.message ?? '';
        if (code === 'P2002' || msg.includes('23P01')) continue;
        throw e;
      }
    }
    return created;
  }

  // ============================================================
  // Сетка смен
  // ============================================================

  async board(
    userId: string,
    workspaceId: string,
    branchId: string,
    from: string,
    to: string,
  ): Promise<ShiftBoardDto> {
    // Права считаются ОДИН раз на запрос: раньше сетка, шаблоны и ростер считали
    // scope каждый по-своему — три `grantSetFor` на один экран.
    const { branch, caps, scope } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    // Черновик — рабочая кухня планировщика; сотрудник видит опубликованное.
    const statusFilter = caps.scheduleManage ? {} : { status: 'published' };

    const [shifts, templates, people] = await Promise.all([
      this.db.shift.findMany({
        where: {
          workspaceId,
          branchId,
          localDate: { gte: dayOf(from), lte: dayOf(to) },
          ...statusFilter,
        },
        include: {
          position: { select: { name: true } },
          template: { select: { name: true, color: true } },
          branch: { select: { name: true } },
          attendance: true,
        },
        orderBy: [{ localDate: 'asc' }, { startsAt: 'asc' }],
      }),
      this.listTemplates(userId, workspaceId, branchId, scope),
      this.objects.people(userId, workspaceId, branchId, scope),
    ]);

    const userIds = [...new Set(shifts.map((s) => s.userId).filter((x): x is string => !!x))];
    const users = await this.db.user.findMany({
      where: { id: { in: [...new Set([...userIds, ...people.map((p) => p.userId)])] } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const myPositions = await this.myPositionIds(userId, workspaceId, branch);

    return {
      branchId,
      branchName: branch.name,
      timeZone: branch.timeZone,
      from,
      to,
      caps,
      templates,
      people: people.map((p) => ({
        userId: p.userId,
        userName: p.userName,
        // Назначение строки: без него сетка не может перенести смену на человека,
        // у которого в этой неделе смен ещё нет.
        assignmentId: p.assignmentId,
        avatar: userById.get(p.userId)?.avatar ?? null,
        positionNames: p.positionName ? p.positionName.split(', ') : [],
      })),
      shifts: shifts.map((s) =>
        this.serializeShift(s, {
          userName: s.userId
            ? [userById.get(s.userId)?.lastName, userById.get(s.userId)?.firstName].filter(Boolean).join(' ') || null
            : null,
          canTake: !s.userId && s.status === 'published' && myPositions.has(s.positionId),
          // Факт коллеги (исход, опоздание и заметка менеджера) — не для всей смены:
          // рядовой видит только СВОЙ.
          hideFact: !caps.attendanceMark && s.userId !== userId,
        }),
      ),
      hasDrafts: shifts.some((s) => s.status === 'draft'),
    };
  }

  // ============================================================
  // Мутации смен
  // ============================================================

  async create(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: CreateShiftInput,
  ): Promise<ShiftDto> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertSchedule(caps);
    const unit = await this.db.staffingPosition.findFirst({
      where: { id: dto.staffingPositionId, workspaceId, branchId },
    });
    if (!unit) throw new BadRequestException('Штатная единица не найдена в этом объекте');

    const assignment = dto.assignmentId
      ? await this.db.staffAssignment.findFirst({ where: { id: dto.assignmentId, workspaceId, branchId } })
      : null;
    if (dto.assignmentId && !assignment) throw new BadRequestException('Назначение не найдено в этом объекте');

    // Шаблон — тоже id из тела: его имя и цвет уезжают в сетку и в календарь,
    // поэтому принадлежность организации проверяется наравне с единицей и назначением.
    if (dto.templateId) {
      const tpl = await this.db.shiftTemplate.findFirst({
        where: { id: dto.templateId, workspaceId, OR: [{ branchId: null }, { branchId }] },
        select: { id: true },
      });
      if (!tpl) throw new BadRequestException('Шаблон смены не найден в этом объекте');
    }

    const settings = this.objects.scheduleSettings(branch);
    const startsAt = localToUtc(branch.timeZone, dto.localDate, dto.startMin);
    const endsAt = new Date(startsAt.getTime() + dto.durationMin * 60_000);
    let forcedReason: string | null = null;
    if (dto.durationMin > settings.maxShiftMin) {
      forcedReason = this.assertForce(
        dto.force,
        caps,
        OBJECTS_ERROR_CODES.shiftTooLong,
        `Смена длиннее ${settings.maxShiftMin / 60} ч`,
      );
    }
    if (assignment) {
      forcedReason =
        (await this.assertRest(
          workspaceId,
          assignment.userId,
          { startsAt, endsAt },
          settings.minRestMin,
          dto.force,
          caps,
          null,
        )) ?? forcedReason;
    }

    const row = await this.db
      .$transaction(async (tx) => {
      const created = await tx.shift.create({
        data: {
          workspaceId,
          branchId,
          staffingPositionId: unit.id,
          positionId: unit.positionId,
          assignmentId: assignment?.id ?? null,
          userId: assignment?.userId ?? null,
          localDate: dayOf(dto.localDate),
          startsAt,
          endsAt,
          breakMin: dto.breakMin ?? 0,
          templateId: dto.templateId ?? null,
          note: dto.note ?? null,
          status: 'draft',
          createdById: userId,
        },
        include: { position: { select: { name: true } }, template: { select: { name: true, color: true } }, branch: { select: { name: true } }, attendance: true },
      });
      await this.logShift(tx, workspaceId, branchId, userId, 'shift.created', created, forcedReason);
      return created;
      })
      // EXCLUDE `shifts_user_no_overlap` — гонка: смену человеку поставили между
      // нашей проверкой и вставкой. Машинный код, а не сырой 23P01.
      .catch((e: unknown) => this.rethrowShiftOverlap(e));
    return this.serializeShift(row, { userName: null, canTake: false });
  }

  async update(
    userId: string,
    workspaceId: string,
    shiftId: string,
    dto: UpdateShiftInput,
  ): Promise<ShiftDto> {
    const shift = await this.shiftOrThrow(workspaceId, shiftId);
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, shift.branchId);
    this.objects.assertSchedule(caps);
    if (shift.status === 'cancelled') throw new ConflictException('Смена отменена');

    const settings = this.objects.scheduleSettings(branch);
    const localDate = dto.localDate ?? dateStr(shift.localDate)!;
    // Минуты начала выводим от СТАРОГО дня смены: от нового они дали бы
    // отрицательный сдвиг, и `localToUtc(новый день, −900)` вернул бы исходный
    // момент — `local_date` уехал бы на новый день, а `starts_at` остался на старом.
    const startMin =
      dto.startMin ??
      Math.round(
        (shift.startsAt.getTime() - localToUtc(branch.timeZone, dateStr(shift.localDate)!, 0).getTime()) / 60_000,
      );
    const durationMin =
      dto.durationMin ?? Math.round((shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000);
    const startsAt = localToUtc(branch.timeZone, localDate, startMin);
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

    let assignment = shift.assignmentId
      ? await this.db.staffAssignment.findUnique({ where: { id: shift.assignmentId } })
      : null;
    if (dto.assignmentId !== undefined) {
      assignment = dto.assignmentId
        ? await this.db.staffAssignment.findFirst({
            where: { id: dto.assignmentId, workspaceId, branchId: shift.branchId },
          })
        : null;
      if (dto.assignmentId && !assignment) throw new BadRequestException('Назначение не найдено в этом объекте');
    }
    let forcedReason: string | null = null;
    if (durationMin > settings.maxShiftMin) {
      forcedReason = this.assertForce(
        dto.force,
        caps,
        OBJECTS_ERROR_CODES.shiftTooLong,
        `Смена длиннее ${settings.maxShiftMin / 60} ч`,
      );
    }
    if (assignment) {
      forcedReason =
        (await this.assertRest(
          workspaceId,
          assignment.userId,
          { startsAt, endsAt },
          settings.minRestMin,
          dto.force,
          caps,
          shiftId,
        )) ?? forcedReason;
    }

    const updated = await this.db
      .$transaction(async (tx) => {
      // Переход состояния — status-guarded updateMany + version (оптимистичная блокировка).
      const res = await tx.shift.updateMany({
        where: {
          id: shiftId,
          status: { not: 'cancelled' },
          ...(dto.version !== undefined ? { version: dto.version } : {}),
        },
        data: {
          localDate: dayOf(localDate),
          startsAt,
          endsAt,
          ...(dto.breakMin !== undefined ? { breakMin: dto.breakMin } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.assignmentId !== undefined
            ? { assignmentId: assignment?.id ?? null, userId: assignment?.userId ?? null }
            : {}),
          version: { increment: 1 },
        },
      });
      if (res.count === 0) {
        throw new ConflictException('Смену уже изменили — обновите страницу');
      }
      const row = await tx.shift.findUniqueOrThrow({
        where: { id: shiftId },
        include: { position: { select: { name: true } }, template: { select: { name: true, color: true } }, branch: { select: { name: true } }, attendance: true },
      });
      if (dto.assignmentId !== undefined) {
        await this.logShift(
          tx,
          workspaceId,
          shift.branchId,
          userId,
          assignment ? 'shift.assigned' : 'shift.unassigned',
          row,
          forcedReason,
        );
      } else if (forcedReason) {
        // Правку тоже можно провести в обход правила отдыха — и это обязано
        // остаться в хронике, иначе «обошли молча».
        await this.chatter.log(tx, {
          refType: 'branch',
          refId: shift.branchId,
          workspaceId,
          actorId: userId,
          typeKey: 'shift.forced',
          payload: { shiftLabel: dateStr(row.localDate), reason: forcedReason },
        });
      }
      return row;
      })
      .catch((e: unknown) => this.rethrowShiftOverlap(e));
    // Изменённая ОПУБЛИКОВАННАЯ смена — адресное уведомление человеку.
    if (updated.status === 'published' && updated.userId) {
      await this.notifyShift('shift.changed', updated, [updated.userId]);
    }
    return this.serializeShift(updated, { userName: null, canTake: false });
  }

  async cancel(userId: string, workspaceId: string, shiftId: string): Promise<ShiftDto> {
    const shift = await this.shiftOrThrow(workspaceId, shiftId);
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, shift.branchId);
    this.objects.assertSchedule(caps);
    const row = await this.db.$transaction(async (tx) => {
      const res = await tx.shift.updateMany({
        where: { id: shiftId, status: { not: 'cancelled' } },
        data: { status: 'cancelled', version: { increment: 1 } },
      });
      if (res.count === 0) throw new ConflictException('Смена уже отменена');
      const updated = await tx.shift.findUniqueOrThrow({
        where: { id: shiftId },
        include: { position: { select: { name: true } }, template: { select: { name: true, color: true } }, branch: { select: { name: true } }, attendance: true },
      });
      await this.logShift(tx, workspaceId, shift.branchId, userId, 'shift.cancelled', updated, null);
      return updated;
    });
    if (row.userId) await this.notifyShift('shift.changed', row, [row.userId]);
    return this.serializeShift(row, { userName: null, canTake: false });
  }

  /** Опубликовать период: черновики становятся видны сотрудникам (дайджест). */
  async publish(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: PublishShiftsInput,
  ): Promise<{ published: number; hasMore: boolean }> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    this.objects.assertSchedule(caps);
    const drafts = await this.db.shift.findMany({
      where: {
        workspaceId,
        branchId,
        status: 'draft',
        localDate: { gte: dayOf(dto.from), lte: dayOf(dto.to) },
      },
      select: { id: true, userId: true },
      orderBy: { localDate: 'asc' },
      // Пачка ограничена, и клиент обязан узнать, что публикация не доедена:
      // молчаливая обрезка оставляла сотни смен черновиками при зелёном ответе.
      take: OBJECT_LIMITS.maxPublishBatch + 1,
    });
    if (drafts.length === 0) return { published: 0, hasMore: false };
    const hasMore = drafts.length > OBJECT_LIMITS.maxPublishBatch;
    const batch = hasMore ? drafts.slice(0, OBJECT_LIMITS.maxPublishBatch) : drafts;

    // Публикуем и считаем ФАКТИЧЕСКИ переведённые: параллельная отмена могла увести
    // часть строк, и в дайджест не должно уходить завышенное число.
    const published = await this.db.$transaction(async (tx) => {
      const res = await tx.shift.updateMany({
        where: { id: { in: batch.map((d) => d.id) }, status: 'draft' },
        data: { status: 'published', publishedAt: new Date(), version: { increment: 1 } },
      });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'shift.published',
        payload: { periodLabel: `${dto.from} — ${dto.to}`, count: res.count, branchName: branch.name },
      });
      return res.count;
    });

    // Дайджест — по одному уведомлению на человека за период.
    const byUser = new Map<string, number>();
    for (const d of batch) if (d.userId) byUser.set(d.userId, (byUser.get(d.userId) ?? 0) + 1);
    for (const [uid, count] of byUser) {
      await this.notifications
        .emitEvent(
          'objects.shifts.published',
          {
            workspaceId,
            userId: uid,
            branchId,
            branchName: branch.name,
            periodLabel: `${dto.from} — ${dto.to}`,
            count,
            href: `/workspaces/${workspaceId}/objects/${branchId}/shifts`,
          },
          'ShiftsService',
        )
        .catch(() => undefined);
    }
    return { published, hasMore };
  }

  /**
   * «Возьму»: открытую опубликованную смену берёт сотрудник с ПОДХОДЯЩЕЙ должностью
   * в этом объекте (или его предке). Право перепроверяется здесь, а не на карточке.
   */
  async take(userId: string, workspaceId: string, shiftId: string): Promise<ShiftDto> {
    const shift = await this.shiftOrThrow(workspaceId, shiftId);
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, shift.branchId);
    if (!caps.view) throw new ForbiddenException('Смена не вашего объекта');
    if (shift.userId || shift.status !== 'published') {
      throw new ConflictException({
        message: 'Смена уже занята или ещё не опубликована',
        details: { code: OBJECTS_ERROR_CODES.shiftNotOpen },
      });
    }
    const mine = await this.myAssignmentFor(userId, workspaceId, branch, shift.positionId);
    if (!mine) {
      throw new ForbiddenException({
        message: 'Эта смена — для другой должности',
        details: { code: OBJECTS_ERROR_CODES.shiftWrongPosition },
      });
    }
    const settings = this.objects.scheduleSettings(branch);
    await this.assertRest(
      workspaceId,
      userId,
      { startsAt: shift.startsAt, endsAt: shift.endsAt },
      settings.minRestMin,
      false,
      caps,
      shiftId,
    );

    const row = await this.db
      .$transaction(async (tx) => {
      // Гонка двух желающих: status-guarded updateMany + userId IS NULL.
      const res = await tx.shift.updateMany({
        where: { id: shiftId, status: 'published', userId: null },
        data: { userId, assignmentId: mine.id, version: { increment: 1 } },
      });
      if (res.count === 0) {
        throw new ConflictException({
          message: 'Смену уже взяли',
          details: { code: OBJECTS_ERROR_CODES.shiftNotOpen },
        });
      }
      const updated = await tx.shift.findUniqueOrThrow({
        where: { id: shiftId },
        include: { position: { select: { name: true } }, template: { select: { name: true, color: true } }, branch: { select: { name: true } }, attendance: true },
      });
      await this.logShift(tx, workspaceId, shift.branchId, userId, 'shift.taken', updated, null);
      return updated;
      })
      .catch((e: unknown) => this.rethrowShiftOverlap(e));

    // Планировщикам объекта — адресно.
    const schedulers = await this.schedulersOf(workspaceId, shift.branchId);
    if (schedulers.length) await this.notifyShift('shift.taken', row, schedulers);
    return this.serializeShift(row, { userName: null, canTake: false });
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /** Должности зрителя в этом объекте и его предках (для «Возьму»). */
  private async myPositionIds(userId: string, workspaceId: string, branch: BranchRow): Promise<Set<string>> {
    const rows = await this.db.staffAssignment.findMany({
      where: { workspaceId, userId, branchId: { in: [branch.id, ...branch.ancestorIds] } },
      select: { positionId: true, startsOn: true, endsOn: true },
    });
    // «Сегодня» — в поясе ОБЪЕКТА: в 02:00 по Алматы UTC-дата ещё вчерашняя, и
    // назначение, начинающееся сегодня, считалось бы не наступившим.
    const today = utcToLocalDate(branch.timeZone, new Date());
    return new Set(rows.filter((r) => isAssignmentActiveOn(r, today)).map((r) => r.positionId));
  }

  private async myAssignmentFor(
    userId: string,
    workspaceId: string,
    branch: BranchRow,
    positionId: string,
  ) {
    const rows = await this.db.staffAssignment.findMany({
      where: {
        workspaceId,
        userId,
        positionId,
        branchId: { in: [branch.id, ...branch.ancestorIds] },
      },
    });
    const today = utcToLocalDate(branch.timeZone, new Date());
    return rows.find((r) => isAssignmentActiveOn(r, today)) ?? null;
  }

  /** Кто ведёт график объекта — для адресных уведомлений. */
  private async schedulersOf(workspaceId: string, branchId: string): Promise<string[]> {
    const branch = await this.db.staffBranch.findUnique({
      where: { id: branchId },
      select: { id: true, ancestorIds: true },
    });
    if (!branch) return [];
    // Право вести график даётся ДВУМЯ путями: ребром на объект (голова/делегат) и
    // ролью организации — у владельца и админа tuple'а нет вовсе. Без второй ветки
    // в маленькой организации, где график ведёт сам владелец, «открытую смену
    // взяли» не приходило никому.
    const [tuples, roles] = await Promise.all([
      this.db.relationTuple.findMany({
        where: {
          resourceType: 'branch',
          resourceId: { in: [branch.id, ...branch.ancestorIds] },
          relation: { in: ['head', 'manager', 'scheduler'] },
          subjectType: 'user',
        },
        select: { subjectId: true },
      }),
      this.db.userRole.findMany({
        where: {
          context: 'workspace',
          tenantId: workspaceId,
          isActive: true,
          role: { in: [...OBJECTS_FULL_SCOPE_ROLES] },
        },
        select: { userId: true },
      }),
    ]);
    return [...new Set([...tuples.map((t) => t.subjectId), ...roles.map((r) => r.userId)])];
  }

  private async assertRest(
    workspaceId: string,
    userId: string,
    candidate: { startsAt: Date; endsAt: Date },
    minRestMin: number,
    force: boolean | undefined,
    caps: ObjectCapsDto,
    excludeShiftId: string | null,
  ): Promise<string | null> {
    const windowStart = new Date(candidate.startsAt.getTime() - (minRestMin + 24 * 60) * 60_000);
    const windowEnd = new Date(candidate.endsAt.getTime() + (minRestMin + 24 * 60) * 60_000);
    const others = await this.db.shift.findMany({
      where: {
        workspaceId,
        userId,
        status: { not: 'cancelled' },
        startsAt: { lt: windowEnd },
        endsAt: { gt: windowStart },
        ...(excludeShiftId ? { id: { not: excludeShiftId } } : {}),
      },
      select: { id: true, startsAt: true, endsAt: true },
    });
    const violation = checkRest(candidate, others, minRestMin);
    if (!violation) return null;
    if (violation.kind === 'overlap') {
      // Пересечение обойти нельзя: физически человек в двух местах не стоит.
      throw new ConflictException({
        message: 'У человека уже есть смена в это время',
        details: { code: OBJECTS_ERROR_CODES.shiftOverlap },
      });
    }
    return this.assertForce(
      force,
      caps,
      OBJECTS_ERROR_CODES.restViolation,
      `Между сменами меньше ${Math.round(minRestMin / 60)} ч (получилось ${Math.round((violation.restMin ?? 0) / 60)} ч)`,
    );
  }

  /**
   * Правило объекта можно обойти ТОЛЬКО с branch.manage. Возвращает ПРИЧИНУ обхода —
   * её пишет в хронику вызывающий: запись `shift.forced` должна появляться там, где
   * правило действительно нарушено, и с настоящей причиной (а не по факту флага).
   */
  private assertForce(
    force: boolean | undefined,
    caps: ObjectCapsDto,
    code: string,
    message: string,
  ): string {
    if (force && caps.manage) return message;
    throw new ConflictException({ message, details: { code } });
  }

  private async assertTemplateRight(
    userId: string,
    workspaceId: string,
    branchId: string | null,
  ): Promise<void> {
    if (branchId) {
      const { caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
      this.objects.assertSchedule(caps);
      return;
    }
    // Шаблон организации правит только owner/admin: он ложится на все объекты.
    const scope = await this.objects.scopeOf(userId, workspaceId);
    if (!scope.full) throw new ForbiddenException('Общий шаблон смен заводит владелец или админ');
  }

  private async assertCycleTemplates(workspaceId: string, cycle: (string | null)[]): Promise<void> {
    const ids = [...new Set(cycle.filter((x): x is string => !!x))];
    if (ids.length === 0) throw new BadRequestException('В цикле нет ни одной смены');
    const found = await this.db.shiftTemplate.count({ where: { id: { in: ids }, workspaceId } });
    if (found !== ids.length) throw new BadRequestException('Шаблон смены не найден в организации');
  }

  /** Объект ротации — контроллеру нужен для проверки права перед генерацией. */
  async patternBranchId(workspaceId: string, patternId: string): Promise<string> {
    const p = await this.db.shiftPattern.findFirst({
      where: { id: patternId, workspaceId },
      select: { branchId: true },
    });
    if (!p) throw new NotFoundException('Ротация не найдена');
    return p.branchId;
  }

  /** 23P01 на shifts → 409 с машинным кодом (клиент не гадает по тексту). */
  private rethrowShiftOverlap(e: unknown): never {
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('23P01') || msg.includes('shifts_user_no_overlap')) {
      throw new ConflictException({
        message: 'У человека уже есть смена в это время',
        details: { code: OBJECTS_ERROR_CODES.shiftOverlap },
      });
    }
    throw e as Error;
  }

  private async shiftOrThrow(workspaceId: string, shiftId: string) {
    const s = await this.db.shift.findFirst({ where: { id: shiftId, workspaceId } });
    if (!s) throw new NotFoundException('Смена не найдена');
    return s;
  }

  private async logShift(
    tx: Tx,
    workspaceId: string,
    branchId: string,
    actorId: string,
    typeKey: string,
    shift: { localDate: Date; startsAt: Date; endsAt: Date; userId: string | null },
    forcedReason: string | null,
  ): Promise<void> {
    const label = `${dateStr(shift.localDate)}`;
    await this.chatter.log(tx, {
      refType: 'branch',
      refId: branchId,
      workspaceId,
      actorId,
      typeKey,
      payload: { shiftLabel: label, targetUserId: shift.userId },
    });
    if (forcedReason) {
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId,
        typeKey: 'shift.forced',
        payload: { shiftLabel: label, reason: forcedReason },
      });
    }
  }

  private async notifyShift(
    type: 'shift.changed' | 'shift.taken',
    shift: { id: string; workspaceId: string; branchId: string; localDate: Date; userId: string | null },
    recipients: string[],
  ): Promise<void> {
    for (const uid of recipients) {
      await this.notifications
        .emitEvent(
          type === 'shift.changed' ? 'objects.shift.changed' : 'objects.shift.taken',
          {
            workspaceId: shift.workspaceId,
            userId: uid,
            branchId: shift.branchId,
            dateLabel: dateStr(shift.localDate),
            href: `/workspaces/${shift.workspaceId}/objects/${shift.branchId}/shifts`,
          },
          'ShiftsService',
        )
        .catch(() => undefined);
    }
  }

  private serializeTemplate(r: {
    id: string;
    branchId: string | null;
    name: string;
    glyph: string | null;
    color: string | null;
    startMin: number;
    durationMin: number;
    breakMin: number;
    sortOrder: number;
    archivedAt: Date | null;
  }, canManage = false): ShiftTemplateDto {
    return {
      id: r.id,
      branchId: r.branchId,
      name: r.name,
      glyph: r.glyph,
      color: r.color,
      startMin: r.startMin,
      durationMin: r.durationMin,
      breakMin: r.breakMin,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      canManage,
    };
  }

  private serializePattern(r: {
    id: string;
    branchId: string;
    assignmentId: string | null;
    staffingPositionId: string | null;
    name: string;
    anchorDate: Date;
    cycle: Prisma.JsonValue;
    activeFrom: Date;
    activeTo: Date | null;
    horizonDays: number;
    archivedAt: Date | null;
  }): ShiftPatternDto {
    return {
      id: r.id,
      branchId: r.branchId,
      assignmentId: r.assignmentId,
      staffingPositionId: r.staffingPositionId,
      name: r.name,
      anchorDate: dateStr(r.anchorDate)!,
      cycle: (r.cycle as (string | null)[]) ?? [],
      activeFrom: dateStr(r.activeFrom)!,
      activeTo: dateStr(r.activeTo),
      horizonDays: r.horizonDays,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    };
  }

  serializeShift(
    s: {
      id: string;
      workspaceId: string;
      branchId: string;
      staffingPositionId: string | null;
      positionId: string;
      assignmentId: string | null;
      userId: string | null;
      localDate: Date;
      startsAt: Date;
      endsAt: Date;
      breakMin: number;
      templateId: string | null;
      patternId: string | null;
      status: string;
      publishedAt: Date | null;
      note: string | null;
      version: number;
      position?: { name: string };
      template?: { name: string; color: string | null } | null;
      branch?: { name: string };
      attendance?: {
        id: string;
        shiftId: string | null;
        branchId: string;
        userId: string;
        localDate: Date;
        outcome: string;
        lateMin: number;
        actualStartAt: Date | null;
        actualEndAt: Date | null;
        source: string;
        note: string | null;
        markedById: string | null;
        markedAt: Date;
      }[];
    },
    extra: { userName: string | null; canTake: boolean; hideFact?: boolean },
  ): ShiftDto {
    const att = extra.hideFact ? null : (s.attendance?.[0] ?? null);
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      branchId: s.branchId,
      branchName: s.branch?.name ?? '',
      staffingPositionId: s.staffingPositionId,
      positionId: s.positionId,
      positionName: s.position?.name ?? '',
      assignmentId: s.assignmentId,
      userId: s.userId,
      userName: extra.userName,
      localDate: dateStr(s.localDate)!,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      breakMin: s.breakMin,
      templateId: s.templateId,
      templateName: s.template?.name ?? null,
      color: s.template?.color ?? null,
      patternId: s.patternId,
      status: s.status as ShiftDto['status'],
      publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
      note: s.note,
      version: s.version,
      attendance: att
        ? {
            id: att.id,
            shiftId: att.shiftId,
            branchId: att.branchId,
            userId: att.userId,
            userName: null,
            localDate: dateStr(att.localDate)!,
            outcome: att.outcome as 'worked' | 'late' | 'absent',
            lateMin: att.lateMin,
            actualStartAt: att.actualStartAt ? att.actualStartAt.toISOString() : null,
            actualEndAt: att.actualEndAt ? att.actualEndAt.toISOString() : null,
            source: att.source as 'manual' | 'access_control' | 'self',
            note: att.note,
            markedById: att.markedById,
            markedAt: att.markedAt.toISOString(),
          }
        : null,
      canTake: extra.canTake,
    };
  }

  /** Неделя, к которой относится дата (для ключей генерации). */
  static weekKey(dateISO: string): string {
    return weekStartOf(dateISO);
  }
}
