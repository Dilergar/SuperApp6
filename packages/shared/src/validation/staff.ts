import { z } from 'zod';

const noHtml = (s: string) => !/[<>]/.test(s);

const staffNameSchema = z
  .string()
  .min(1, 'Название не может быть пустым')
  .max(100, 'Название слишком длинное')
  .refine(noHtml, 'Недопустимые символы');

const staffTextSchema = (max: number, msg: string) =>
  z.string().max(max, msg).refine(noHtml, 'Недопустимые символы');

export const staffAssignmentStatusSchema = z.enum(['training', 'certified']);

// ---------- Отделы ----------

/** Значок должности: ключ реестра иконок или эмодзи — данные, рисует <Glyph/> */
const glyphSchema = z.string().max(64).refine(noHtml, 'Недопустимые символы');

export const createStaffDepartmentSchema = z.object({
  name: staffNameSchema,
  parentId: z.string().uuid().nullable().optional(),
  /** Руководящая должность отдела (может лежать вне отдела) */
  headPositionId: z.string().uuid().nullable().optional(),
});

export const updateStaffDepartmentSchema = z
  .object({
    name: staffNameSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    headPositionId: z.string().uuid().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Должности ----------

export const createStaffPositionSchema = z.object({
  name: staffNameSchema,
  departmentId: z.string().uuid().nullable().optional(),
  description: staffTextSchema(500, 'Описание слишком длинное').nullable().optional(),
  /** Точечное переопределение подчинения (сильнее дерева отделов) */
  reportsToPositionId: z.string().uuid().nullable().optional(),
  glyph: glyphSchema.nullable().optional(),
});

export const updateStaffPositionSchema = z
  .object({
    name: staffNameSchema.optional(),
    departmentId: z.string().uuid().nullable().optional(),
    description: staffTextSchema(500, 'Описание слишком длинное').nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    reportsToPositionId: z.string().uuid().nullable().optional(),
    glyph: glyphSchema.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Объекты (в UI пока «Филиалы») ----------

export const createStaffBranchSchema = z.object({
  name: staffNameSchema,
  address: staffTextSchema(300, 'Адрес слишком длинный').nullable().optional(),
  note: staffTextSchema(500, 'Комментарий слишком длинный').nullable().optional(),
  /** Руководящая должность объекта */
  headPositionId: z.string().uuid().nullable().optional(),
});

export const updateStaffBranchSchema = z
  .object({
    name: staffNameSchema.optional(),
    address: staffTextSchema(300, 'Адрес слишком длинный').nullable().optional(),
    note: staffTextSchema(500, 'Комментарий слишком длинный').nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    headPositionId: z.string().uuid().nullable().optional(),
    /**
     * Сделать основным. Только `true`: снять флаг нельзя — основной объект у организации
     * есть всегда, перенос флага = явное действие на ДРУГОМ объекте (старый снимается
     * в той же транзакции).
     */
    isDefault: z.literal(true).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Назначения ----------

export const assignStaffPositionSchema = z.object({
  positionId: z.string().uuid(),
  /** Объект назначения; пусто — основной объект организации */
  branchId: z.string().uuid().nullable().optional(),
  status: staffAssignmentStatusSchema.optional(),
  /** Сделать основным местом (первое назначение — основное само) */
  isPrimary: z.boolean().optional(),
});

export const updateStaffAssignmentSchema = z
  .object({
    /** Перевод в другой объект (без объекта назначение не бывает — null отвергается) */
    branchId: z.string().uuid().optional(),
    status: staffAssignmentStatusSchema.optional(),
    /** Только `true`: основное место есть всегда, «снять» = сделать основным другое */
    isPrimary: z.literal(true).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---- Входные типы: ЕДИНСТВЕННОЕ описание формы входа ----
// Рукописные интерфейсы в types/*.ts удалены: два независимых описания одного
// входа расходятся молча (Zod уходил вперёд, интерфейс врал).
export type CreateStaffDepartmentInput = z.infer<typeof createStaffDepartmentSchema>;
export type UpdateStaffDepartmentInput = z.infer<typeof updateStaffDepartmentSchema>;
export type CreateStaffPositionInput = z.infer<typeof createStaffPositionSchema>;
export type UpdateStaffPositionInput = z.infer<typeof updateStaffPositionSchema>;
export type CreateStaffBranchInput = z.infer<typeof createStaffBranchSchema>;
export type UpdateStaffBranchInput = z.infer<typeof updateStaffBranchSchema>;
export type AssignStaffPositionInput = z.infer<typeof assignStaffPositionSchema>;
export type UpdateStaffAssignmentInput = z.infer<typeof updateStaffAssignmentSchema>;
