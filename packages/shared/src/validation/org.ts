import { z } from 'zod';
import { ORG_LIMITS } from '../constants/org';
import { queryBoolean } from './query';

const noHtml = (s: string) => !/[<>]/.test(s);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

// ---------- Заместители ----------

const deputyTarget = {
  deputyPositionId: z.string().uuid().nullable().optional(),
  deputyUserId: z.string().uuid().nullable().optional(),
};

export const createStaffDeputySchema = z
  .object({
    positionId: z.string().uuid(),
    /** null = во всех объектах */
    branchId: z.string().uuid().nullable().optional(),
    ...deputyTarget,
    startsOn: isoDate.nullable().optional(),
    endsOn: isoDate.nullable().optional(),
    note: z.string().max(300, 'Комментарий слишком длинный').refine(noHtml, 'Недопустимые символы').nullable().optional(),
  })
  .strict()
  .refine((d) => !!d.deputyPositionId !== !!d.deputyUserId, {
    message: 'Укажите ровно одно: должность-заместителя или человека',
    path: ['deputyUserId'],
  })
  .refine((d) => !d.deputyPositionId || d.deputyPositionId !== d.positionId, {
    message: 'Должность не может замещать сама себя',
    path: ['deputyPositionId'],
  })
  .refine((d) => !d.startsOn || !d.endsOn || d.endsOn >= d.startsOn, {
    message: 'Конец периода раньше начала',
    path: ['endsOn'],
  });

export const updateStaffDeputySchema = z
  .object({
    startsOn: isoDate.nullable().optional(),
    endsOn: isoDate.nullable().optional(),
    note: z.string().max(300).refine(noHtml, 'Недопустимые символы').nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять')
  .refine((d) => !d.startsOn || !d.endsOn || d.endsOn >= d.startsOn, {
    message: 'Конец периода раньше начала',
    path: ['endsOn'],
  });

export const listStaffDeputiesQuerySchema = z.object({
  positionId: z.string().uuid().optional(),
  /** Только действующие сегодня (датированные в периоде + все запасные). Только queryBoolean! */
  activeOnly: queryBoolean.optional(),
});

// ---------- Чтение графа ----------

export const orgChartQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  /** Должность или человек, вокруг которых собирается фокус (клиентская подсветка) */
  focus: z.string().max(80).optional(),
});

export const orgLineQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  assignmentId: z.string().uuid().optional(),
});

// ---------- Мастер «Соберём структуру» ----------

export const orgSetupSchema = z
  .object({
    /** Вершина: существующая должность ИЛИ новая (создаётся), опционально её держатель */
    top: z
      .object({
        positionId: z.string().uuid().optional(),
        newPositionName: z.string().min(1).max(100).refine(noHtml, 'Недопустимые символы').optional(),
        userId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .refine((t) => !!t.positionId !== !!t.newPositionName, {
        message: 'Укажите существующую должность либо название новой',
        path: ['positionId'],
      })
      .optional(),
    departmentHeads: z
      .array(z.object({ departmentId: z.string().uuid(), positionId: z.string().uuid().nullable() }).strict())
      .max(500)
      .optional(),
    branchHeads: z
      .array(z.object({ branchId: z.string().uuid(), positionId: z.string().uuid().nullable() }).strict())
      .max(500)
      .optional(),
  })
  .strict();

export type CreateStaffDeputyInput = z.infer<typeof createStaffDeputySchema>;
export type UpdateStaffDeputyInput = z.infer<typeof updateStaffDeputySchema>;
export type OrgSetupInput = z.infer<typeof orgSetupSchema>;

/** Потолок графа на входе (для симметрии клиент/сервер) */
export const ORG_CHART_MAX = ORG_LIMITS.maxChartPositions;
