import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_SCHEDULE_SETTINGS,
  type AttendanceDto,
  type GateEventInput,
  type MarkAttendanceInput,
  type UnplannedAttendanceInput,
  type UpdateAttendanceInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { ObjectsService } from './objects.service';
import { utcToLocalDate } from './shift-time';

function dayOf(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const OUTCOME_LABEL: Record<string, string> = {
  worked: 'вышел',
  late: 'опоздал',
  absent: 'не вышел',
};

/**
 * ФАКТ выходов. План (Shift) и факт (ShiftAttendance) — разные записи: смену мог
 * закрыть не тот, кому она назначена, и сверка «план ≠ факт» обязана это видеть.
 *
 * Сегодня факт ставит менеджер рукой (`source='manual'`); порт
 * `recordAttendanceSystem` пишет то же самое от пропускной системы
 * (`source='access_control'`) — таблица ОДНА, чтобы отчёты не собирались из двух.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatter: ChatterService,
    private readonly objects: ObjectsService,
  ) {}

  /** Отметить факт по ПЛАНОВОЙ смене (управляющий/планировщик объекта). */
  async markForShift(
    userId: string,
    workspaceId: string,
    shiftId: string,
    dto: MarkAttendanceInput,
  ): Promise<AttendanceDto> {
    const shift = await this.db.shift.findFirst({ where: { id: shiftId, workspaceId } });
    if (!shift) throw new NotFoundException('Смена не найдена');
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, shift.branchId);
    if (!caps.attendanceMark) throw new ForbiddenException('Факт отмечает управляющий объектом');
    if (!shift.userId) throw new ConflictException('Смена открытая — некому отмечать выход');
    if (shift.status === 'cancelled') throw new ConflictException('Смена отменена');

    const row = await this.db.$transaction(async (tx) => {
      // Один факт на смену (рукописный партиальный уникум — Prisma его не выражает,
      // поэтому не upsert, а «найди и поправь»): повторная отметка ПРАВИТ запись.
      const existing = await tx.shiftAttendance.findFirst({ where: { shiftId } });
      const fields = {
        outcome: dto.outcome,
        lateMin: dto.lateMin ?? 0,
        actualStartAt: dto.actualStartAt ? new Date(dto.actualStartAt) : null,
        actualEndAt: dto.actualEndAt ? new Date(dto.actualEndAt) : null,
        source: 'manual',
        markedById: userId,
        markedAt: new Date(),
        note: dto.note ?? null,
      };
      const saved = existing
        ? await tx.shiftAttendance.update({ where: { id: existing.id }, data: fields })
        : await tx.shiftAttendance.create({
            data: {
              workspaceId,
              branchId: shift.branchId,
              shiftId,
              userId: shift.userId!,
              localDate: shift.localDate,
              ...fields,
            },
          });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: shift.branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'attendance.marked',
        payload: {
          targetUserId: shift.userId,
          dateLabel: dateStr(shift.localDate),
          outcomeLabel: OUTCOME_LABEL[dto.outcome] ?? dto.outcome,
        },
      });
      return saved;
    });
    return this.serialize(row);
  }

  /** Внеплановый выход: смены в плане не было (подмена, аврал). */
  async markUnplanned(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: UnplannedAttendanceInput,
  ): Promise<AttendanceDto> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    if (!caps.attendanceMark) throw new ForbiddenException('Факт отмечает управляющий объектом');
    await this.assertWorksHere(workspaceId, branch, dto.userId);
    const row = await this.db.$transaction(async (tx) => {
      const saved = await tx.shiftAttendance.create({
        data: {
          workspaceId,
          branchId,
          shiftId: null,
          userId: dto.userId,
          localDate: dayOf(dto.localDate),
          outcome: dto.outcome,
          lateMin: dto.lateMin ?? 0,
          actualStartAt: dto.actualStartAt ? new Date(dto.actualStartAt) : null,
          actualEndAt: dto.actualEndAt ? new Date(dto.actualEndAt) : null,
          source: 'manual',
          markedById: userId,
          markedAt: new Date(),
          note: dto.note ?? null,
        },
      });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'attendance.marked',
        payload: {
          targetUserId: dto.userId,
          dateLabel: dto.localDate,
          outcomeLabel: OUTCOME_LABEL[dto.outcome] ?? dto.outcome,
        },
      });
      return saved;
    });
    return this.serialize(row);
  }

  /**
   * ТАБЕЛЬ объекта за период: плановые смены и ВНЕПЛАНОВЫЕ выходы одной лентой.
   *
   * Без этой ручки запись с `shiftId = null` была «в один конец»: её не возвращала
   * ни сетка (она подтягивает факт через смену), ни штатка (там только агрегат), —
   * ошибка в человеке или дате навсегда портила счётчики.
   *
   * Рядовой сотрудник видит ТОЛЬКО СВОИ строки: исход, опоздание и заметка
   * менеджера про коллегу — не для всей смены.
   */
  async list(
    userId: string,
    workspaceId: string,
    branchId: string,
    from: string,
    to: string,
  ): Promise<AttendanceDto[]> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    const subtree = await this.db.staffBranch.findMany({
      where: { workspaceId, OR: [{ id: branch.id }, { ancestorIds: { has: branch.id } }] },
      select: { id: true },
    });
    const rows = await this.db.shiftAttendance.findMany({
      where: {
        workspaceId,
        branchId: { in: subtree.map((b) => b.id) },
        localDate: { gte: dayOf(from), lte: dayOf(to) },
        ...(caps.attendanceMark ? {} : { userId }),
      },
      orderBy: [{ localDate: 'desc' }, { markedAt: 'desc' }],
      take: 500,
    });
    const users = await this.db.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, firstName: true, lastName: true },
    });
    const nameOf = new Map(
      users.map((u) => [u.id, [u.lastName, u.firstName].filter(Boolean).join(' ') || 'Сотрудник']),
    );
    return rows.map((r) => ({ ...this.serialize(r), userName: nameOf.get(r.userId) ?? null }));
  }

  /** Правка записи факта — включая внеплановую (иначе её не исправить). */
  async update(
    userId: string,
    workspaceId: string,
    attendanceId: string,
    dto: UpdateAttendanceInput,
  ): Promise<AttendanceDto> {
    const { row, caps, branchId } = await this.factOrThrow(userId, workspaceId, attendanceId);
    if (!caps.attendanceMark) throw new ForbiddenException('Факт правит управляющий объектом');
    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.shiftAttendance.update({
        where: { id: attendanceId },
        data: {
          ...(dto.outcome !== undefined ? { outcome: dto.outcome } : {}),
          ...(dto.lateMin !== undefined ? { lateMin: dto.lateMin } : {}),
          ...(dto.localDate !== undefined ? { localDate: dayOf(dto.localDate) } : {}),
          ...(dto.actualStartAt !== undefined
            ? { actualStartAt: dto.actualStartAt ? new Date(dto.actualStartAt) : null }
            : {}),
          ...(dto.actualEndAt !== undefined
            ? { actualEndAt: dto.actualEndAt ? new Date(dto.actualEndAt) : null }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          // Правка руками — рука менеджера: источник записи становится ручным.
          source: 'manual',
          markedById: userId,
          markedAt: new Date(),
        },
      });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'attendance.marked',
        payload: {
          targetUserId: next.userId,
          dateLabel: dateStr(next.localDate),
          outcomeLabel: OUTCOME_LABEL[next.outcome] ?? next.outcome,
        },
      });
      return next;
    });
    return this.serialize(updated);
  }

  /** Удалить ошибочную запись факта. */
  async remove(userId: string, workspaceId: string, attendanceId: string): Promise<void> {
    const { row, caps, branchId } = await this.factOrThrow(userId, workspaceId, attendanceId);
    if (!caps.attendanceMark) throw new ForbiddenException('Факт правит управляющий объектом');
    await this.db.$transaction(async (tx) => {
      await tx.shiftAttendance.delete({ where: { id: attendanceId } });
      await this.chatter.log(tx, {
        refType: 'branch',
        refId: branchId,
        workspaceId,
        actorId: userId,
        typeKey: 'attendance.removed',
        payload: { targetUserId: row.userId, dateLabel: dateStr(row.localDate) },
      });
    });
  }

  private async factOrThrow(userId: string, workspaceId: string, attendanceId: string) {
    const row = await this.db.shiftAttendance.findFirst({ where: { id: attendanceId, workspaceId } });
    if (!row) throw new NotFoundException('Запись табеля не найдена');
    const { caps } = await this.objects.getOrThrow(userId, workspaceId, row.branchId);
    return { row, caps, branchId: row.branchId };
  }

  /**
   * Ручка интеграции: пропускная система ходит под своей учётной записью, право
   * `branch.attendance.mark` проверяется ЗДЕСЬ — порт `recordAttendanceSystem`
   * ниже прав не проверяет по контракту `system*`.
   */
  async recordGateEvent(
    userId: string,
    workspaceId: string,
    branchId: string,
    dto: GateEventInput,
  ): Promise<AttendanceDto | null> {
    const { branch, caps } = await this.objects.getOrThrow(userId, workspaceId, branchId);
    if (!caps.attendanceMark) throw new ForbiddenException('Нет права отмечать выходы в этом объекте');
    await this.assertWorksHere(workspaceId, branch, dto.userId);
    return this.recordAttendanceSystem({
      workspaceId,
      branchId,
      userId: dto.userId,
      at: new Date(dto.at),
      direction: dto.direction,
      source: 'access_control',
      sourceRef: dto.sourceRef ?? null,
    });
  }

  /**
   * ПОРТ пропускной системы (`system*` — прав НЕ проверяет, право проверил
   * вызывающий): событие «прошёл через турникет» матчится с ближайшей
   * опубликованной сменой в окне допуска и превращается в факт.
   *
   * Опоздание считается от ПЛАНОВОГО начала с допуском объекта: приход в 09:07 при
   * допуске 10 минут — «вышел», в 09:25 — «опоздал на 25».
   */
  async recordAttendanceSystem(args: {
    workspaceId: string;
    userId: string;
    branchId: string;
    at: Date;
    direction: 'in' | 'out';
    source?: 'access_control' | 'self';
    sourceRef?: string | null;
  }): Promise<AttendanceDto | null> {
    const branch = await this.db.staffBranch.findFirst({
      where: { id: args.branchId, workspaceId: args.workspaceId },
    });
    if (!branch) throw new NotFoundException('Объект не найден');
    const settings = this.objects.scheduleSettings(branch);
    const tolerance = settings.lateToleranceMin ?? DEFAULT_SCHEDULE_SETTINGS.lateToleranceMin;
    const localDate = utcToLocalDate(branch.timeZone, args.at);

    // Повтор доставки события устройства — не второй выход. Ретрай вебхука обязан
    // вернуть ту же запись, а не завести ещё одну (партиальный уникум по
    // (workspace_id, source_ref) страхует гонку двух доставок в БД).
    if (args.sourceRef) {
      const already = await this.db.shiftAttendance.findFirst({
        where: { workspaceId: args.workspaceId, sourceRef: args.sourceRef },
      });
      if (already) return this.serialize(already);
    }

    // Смена, ПЕРЕСЕКАЮЩАЯ окно ±12 ч от события, а не целиком лежащая внутри него:
    // условие «вся смена внутри окна» на 12-часовой смене вырождается в
    // «событие ровно между началом и концом» — приход за минуту до начала уже не
    // матчился, а уход после конца не записывался никогда.
    const window = 12 * 60 * 60_000;
    const shifts = await this.db.shift.findMany({
      where: {
        workspaceId: args.workspaceId,
        branchId: args.branchId,
        userId: args.userId,
        status: 'published',
        startsAt: { lte: new Date(args.at.getTime() + window) },
        endsAt: { gte: new Date(args.at.getTime() - window) },
      },
      orderBy: { startsAt: 'asc' },
    });
    const shift =
      shifts.length === 0
        ? null
        : shifts.reduce((best, s) =>
            Math.abs(s.startsAt.getTime() - args.at.getTime()) <
            Math.abs(best.startsAt.getTime() - args.at.getTime())
              ? s
              : best,
          );

    if (args.direction === 'out') {
      // Уход: дописываем факт. времени в уже существующую запись; своей смены нет —
      // событие не теряем, но и записи не создаём (нечего закрывать).
      if (!shift) return null;
      const existing = await this.db.shiftAttendance.findFirst({ where: { shiftId: shift.id } });
      if (!existing) return null;
      const updated = await this.db.shiftAttendance.update({
        where: { id: existing.id },
        data: { actualEndAt: args.at, sourceRef: args.sourceRef ?? existing.sourceRef },
      });
      return this.serialize(updated);
    }

    const lateMin = shift
      ? Math.max(0, Math.round((args.at.getTime() - shift.startsAt.getTime()) / 60_000))
      : 0;
    const outcome = lateMin > tolerance ? 'late' : 'worked';
    const data = {
      workspaceId: args.workspaceId,
      branchId: args.branchId,
      shiftId: shift?.id ?? null,
      userId: args.userId,
      localDate: shift ? shift.localDate : dayOf(localDate),
      outcome,
      lateMin: outcome === 'late' ? lateMin : 0,
      actualStartAt: args.at,
      source: args.source ?? 'access_control',
      sourceRef: args.sourceRef ?? null,
      markedById: null,
      markedAt: new Date(),
    };
    let row;
    if (shift) {
      const existing = await this.db.shiftAttendance.findFirst({ where: { shiftId: shift.id } });
      row = existing
        ? // Рука менеджера сильнее устройства: отмеченный вручную факт устройство
          // не перебивает, только дополняет фактическим временем.
          await this.db.shiftAttendance.update({
            where: { id: existing.id },
            data: { actualStartAt: args.at, sourceRef: args.sourceRef ?? existing.sourceRef },
          })
        : await this.db.shiftAttendance.create({ data });
    } else {
      row = await this.db.shiftAttendance.create({ data });
    }
    return this.serialize(row);
  }

  /**
   * Табель — про СВОИХ. У `shift_attendance.user_id` внешнего ключа нет вовсе,
   * поэтому принадлежность проверяется здесь: иначе в табель своей организации
   * можно записать постороннего человека по одному только uuid.
   *
   * По датам НЕ фильтруем: отметить прошлый выход уже уволенного — законно;
   * проверяется сам факт, что человек когда-либо работал в этой вертикали.
   */
  private async assertWorksHere(
    workspaceId: string,
    branch: { id: string; ancestorIds: string[] },
    targetUserId: string,
  ): Promise<void> {
    const scopeBranches = await this.db.staffBranch.findMany({
      where: {
        workspaceId,
        OR: [{ id: { in: [branch.id, ...branch.ancestorIds] } }, { ancestorIds: { has: branch.id } }],
      },
      select: { id: true },
    });
    const found = await this.db.staffAssignment.findFirst({
      where: { workspaceId, userId: targetUserId, branchId: { in: scopeBranches.map((b) => b.id) } },
      select: { id: true },
    });
    if (!found) throw new BadRequestException('Этот человек не работает в этом объекте');
  }

  private serialize(r: {
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
  }): AttendanceDto {
    return {
      id: r.id,
      shiftId: r.shiftId,
      branchId: r.branchId,
      userId: r.userId,
      userName: null,
      localDate: dateStr(r.localDate),
      outcome: r.outcome as AttendanceDto['outcome'],
      lateMin: r.lateMin,
      actualStartAt: r.actualStartAt ? r.actualStartAt.toISOString() : null,
      actualEndAt: r.actualEndAt ? r.actualEndAt.toISOString() : null,
      source: r.source as AttendanceDto['source'],
      note: r.note,
      markedById: r.markedById,
      markedAt: r.markedAt.toISOString(),
    };
  }
}
