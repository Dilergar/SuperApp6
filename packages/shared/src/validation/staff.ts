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

export const createStaffDepartmentSchema = z.object({
  name: staffNameSchema,
  parentId: z.string().uuid().nullable().optional(),
});

export const updateStaffDepartmentSchema = z
  .object({
    name: staffNameSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Должности ----------

export const createStaffPositionSchema = z.object({
  name: staffNameSchema,
  departmentId: z.string().uuid().nullable().optional(),
  description: staffTextSchema(500, 'Описание слишком длинное').nullable().optional(),
});

export const updateStaffPositionSchema = z
  .object({
    name: staffNameSchema.optional(),
    departmentId: z.string().uuid().nullable().optional(),
    description: staffTextSchema(500, 'Описание слишком длинное').nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Филиалы ----------

export const createStaffBranchSchema = z.object({
  name: staffNameSchema,
  address: staffTextSchema(300, 'Адрес слишком длинный').nullable().optional(),
  note: staffTextSchema(500, 'Комментарий слишком длинный').nullable().optional(),
});

export const updateStaffBranchSchema = z
  .object({
    name: staffNameSchema.optional(),
    address: staffTextSchema(300, 'Адрес слишком длинный').nullable().optional(),
    note: staffTextSchema(500, 'Комментарий слишком длинный').nullable().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');

// ---------- Назначения ----------

export const assignStaffPositionSchema = z.object({
  positionId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  status: staffAssignmentStatusSchema.optional(),
});

export const updateStaffAssignmentSchema = z
  .object({
    branchId: z.string().uuid().nullable().optional(),
    status: staffAssignmentStatusSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Нечего обновлять');
