import { z } from 'zod';
import {
  ASSET_KINDS,
  ASSET_SERVICE_KINDS,
  ASSET_SERVICE_STATUSES,
  ASSET_STATUSES,
  ATTENDANCE_OUTCOMES,
  HOLDING_KINDS,
  OBJECT_KINDS,
  OBJECT_LIMITS,
  RATE_TYPES,
} from '../constants/objects';
import { queryBoolean } from './query';

// ============================================================
// Сервис «Объекты» — схемы входа (вход API = z.infer из этих схем).
// ============================================================

const noHtml = (s: string) => !/[<>]/.test(s);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const text = (max: number) => z.string().trim().max(max).refine(noHtml, 'Недопустимые символы');
const objectName = z
  .string()
  .trim()
  .min(1, 'Укажите название')
  .max(OBJECT_LIMITS.nameMaxLength)
  .refine(noHtml, 'Недопустимые символы');

const kindEnum = z.enum(OBJECT_KINDS.map((k) => k.value) as [string, ...string[]]);
const rateTypeEnum = z.enum(RATE_TYPES.map((r) => r.value) as [string, ...string[]]);
const outcomeEnum = z.enum(ATTENDANCE_OUTCOMES.map((o) => o.value) as [string, ...string[]]);
const assetStatusEnum = z.enum(ASSET_STATUSES.map((s) => s.value) as [string, ...string[]]);
const holdingEnum = z.enum(HOLDING_KINDS.map((h) => h.value) as [string, ...string[]]);
const assetKindEnum = z.enum(ASSET_KINDS.map((k) => k.value) as [string, ...string[]]);
const serviceKindEnum = z.enum(ASSET_SERVICE_KINDS.map((k) => k.value) as [string, ...string[]]);
const serviceStatusEnum = z.enum(ASSET_SERVICE_STATUSES.map((s) => s.value) as [string, ...string[]]);

/** Деньги приходят ЦЕЛЫМИ ТИЫНАМИ строкой (BigInt на проводе — только строкой) */
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}$/, 'Сумма — целое число тиынов строкой');

/** Часовой пояс IANA: проверяем существование, а не формат (Intl — правда платформы) */
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Неизвестный часовой пояс');

export const scheduleSettingsSchema = z
  .object({
    minRestMin: z.number().int().min(0).max(24 * 60),
    maxShiftMin: z.number().int().min(60).max(24 * 60),
    lateToleranceMin: z.number().int().min(0).max(240),
    weekStartsOn: z.number().int().min(0).max(6),
    accountingPeriod: z.enum(['month', 'week']),
  })
  .partial()
  .strict();

// ---------- Объект ----------

export const createObjectSchema = z
  .object({
    name: objectName,
    kind: kindEnum.default('site'),
    parentId: z.string().uuid().nullable().optional(),
    address: text(300).nullable().optional(),
    timeZone: timeZoneSchema.optional(),
    legalEntityId: z.string().uuid().nullable().optional(),
    glyph: text(60).nullable().optional(),
    headPositionId: z.string().uuid().nullable().optional(),
    note: text(OBJECT_LIMITS.noteMaxLength).nullable().optional(),
    scheduleSettings: scheduleSettingsSchema.optional(),
  })
  .strict();

export const updateObjectSchema = z
  .object({
    name: objectName.optional(),
    kind: kindEnum.optional(),
    address: text(300).nullable().optional(),
    timeZone: timeZoneSchema.optional(),
    legalEntityId: z.string().uuid().nullable().optional(),
    glyph: text(60).nullable().optional(),
    headPositionId: z.string().uuid().nullable().optional(),
    note: text(OBJECT_LIMITS.noteMaxLength).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    scheduleSettings: scheduleSettingsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const moveObjectSchema = z
  .object({ parentId: z.string().uuid().nullable() })
  .strict();

export const objectTreeQuerySchema = z
  .object({ archived: queryBoolean.optional() })
  .strict();

// ---------- Штатное расписание ----------

const rateInputSchema = z
  .object({
    rateType: rateTypeEnum,
    amount: moneySchema,
    currency: z.string().trim().length(3).optional(),
    effectiveFrom: isoDate.optional(),
    note: text(200).nullable().optional(),
  })
  .strict();

export const createStaffingPositionSchema = z
  .object({
    positionId: z.string().uuid(),
    headcount: z.number().int().min(0).max(OBJECT_LIMITS.maxHeadcount).default(1),
    plannedRate: rateInputSchema.optional(),
    shiftTemplateId: z.string().uuid().nullable().optional(),
    note: text(300).nullable().optional(),
  })
  .strict();

export const updateStaffingPositionSchema = z
  .object({
    headcount: z.number().int().min(0).max(OBJECT_LIMITS.maxHeadcount).optional(),
    shiftTemplateId: z.string().uuid().nullable().optional(),
    note: text(300).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const assignToStaffingSchema = z
  .object({
    userId: z.string().uuid(),
    staffingPositionId: z.string().uuid(),
    startsOn: isoDate.optional(),
    rateShare: z.number().min(0.05).max(2).optional(),
    rate: rateInputSchema.optional(),
  })
  .strict();

export const updateStaffingAssignmentSchema = z
  .object({
    startsOn: isoDate.nullable().optional(),
    endsOn: isoDate.nullable().optional(),
    rateShare: z.number().min(0.05).max(2).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять')
  .refine(
    (v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn,
    { message: 'Дата окончания раньше начала', path: ['endsOn'] },
  );

export const closeAssignmentSchema = z.object({ endsOn: isoDate }).strict();

export const setRateSchema = rateInputSchema;

export const staffingQuerySchema = z
  .object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'Период в формате ГГГГ-ММ').optional() })
  .strict();

// ---------- Смены ----------

export const shiftTemplateSchema = z
  .object({
    name: text(60).pipe(z.string().min(1, 'Укажите название')),
    startMin: z.number().int().min(0).max(24 * 60 - 1),
    // Потолок ТЕХНИЧЕСКИЙ (сутки). Доменный — `scheduleSettings.maxShiftMin` объекта,
    // и проверяет его сервис: иначе объект «сутки через трое» не смог бы поставить
    // смену даже с `force` — Zod резал бы её раньше правил объекта.
    durationMin: z.number().int().min(15).max(24 * 60),
    breakMin: z.number().int().min(0).max(480).optional(),
    color: text(20).nullable().optional(),
    glyph: text(60).nullable().optional(),
    /** null = шаблон для всех объектов организации */
    branchId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export const updateShiftTemplateSchema = shiftTemplateSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const shiftPatternSchema = z
  .object({
    name: text(60).pipe(z.string().min(1, 'Укажите название')),
    assignmentId: z.string().uuid().nullable().optional(),
    staffingPositionId: z.string().uuid().nullable().optional(),
    anchorDate: isoDate,
    /** По элементу на день цикла: id шаблона или null (выходной) */
    cycle: z.array(z.string().uuid().nullable()).min(1).max(31),
    activeFrom: isoDate,
    activeTo: isoDate.nullable().optional(),
    horizonDays: z.number().int().min(7).max(OBJECT_LIMITS.horizonDays).optional(),
  })
  .strict()
  .refine((v) => !!v.assignmentId !== !!v.staffingPositionId, {
    message: 'Укажите ровно одно: человека или штатную единицу',
    path: ['assignmentId'],
  })
  .refine((v) => !v.activeTo || v.activeTo >= v.activeFrom, {
    message: 'Окончание раньше начала',
    path: ['activeTo'],
  });

export const createShiftSchema = z
  .object({
    localDate: isoDate,
    startMin: z.number().int().min(0).max(24 * 60 - 1),
    // Потолок ТЕХНИЧЕСКИЙ (сутки). Доменный — `scheduleSettings.maxShiftMin` объекта,
    // и проверяет его сервис: иначе объект «сутки через трое» не смог бы поставить
    // смену даже с `force` — Zod резал бы её раньше правил объекта.
    durationMin: z.number().int().min(15).max(24 * 60),
    breakMin: z.number().int().min(0).max(480).optional(),
    staffingPositionId: z.string().uuid(),
    /** null = ОТКРЫТАЯ смена (её можно взять) */
    assignmentId: z.string().uuid().nullable().optional(),
    templateId: z.string().uuid().nullable().optional(),
    note: text(300).nullable().optional(),
    /** Обойти проверку отдыха/длины — только с branch.manage, пишется в хронику */
    force: z.boolean().optional(),
  })
  .strict();

export const updateShiftSchema = z
  .object({
    localDate: isoDate.optional(),
    startMin: z.number().int().min(0).max(24 * 60 - 1).optional(),
    durationMin: z.number().int().min(15).max(24 * 60).optional(),
    breakMin: z.number().int().min(0).max(480).optional(),
    assignmentId: z.string().uuid().nullable().optional(),
    note: text(300).nullable().optional(),
    /** Оптимистичная блокировка: версия, которую видел клиент */
    version: z.number().int().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const publishShiftsSchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine((v) => v.to >= v.from, { message: 'Конец периода раньше начала', path: ['to'] });

export const shiftsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .strict()
  .refine((v) => v.to >= v.from, { message: 'Конец периода раньше начала', path: ['to'] })
  // Окно ограничено: без потолка `?from=2020-01-01&to=2030-01-01` тянет ВСЕ смены
  // объекта со связями и без лимита.
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= OBJECT_LIMITS.maxBoardDays, {
    message: `Период сетки — не больше ${OBJECT_LIMITS.maxBoardDays} дней`,
    path: ['to'],
  });

/** Справочник шаблонов: `branchId` — объект, чьи шаблоны показать (право проверяет сервис) */
export const shiftTemplatesQuerySchema = z
  .object({ branchId: z.string().uuid().optional() })
  .strict();

/** Поля факта выхода — общие у отметки по смене и у внепланового выхода. */
const attendanceFactShape = z
  .object({
    outcome: outcomeEnum,
    lateMin: z.number().int().min(0).max(24 * 60).optional(),
    actualStartAt: z.string().datetime().nullable().optional(),
    actualEndAt: z.string().datetime().nullable().optional(),
    note: text(300).nullable().optional(),
  })
  .strict();

// Смена через полночь нормальна, но КОНЕЦ РАНЬШЕ НАЧАЛА — нет: у ночной смены
// фактическое окончание уезжает на следующие сутки, а не на те же.
const spanOrder = {
  check: (v: { actualStartAt?: string | null; actualEndAt?: string | null }) =>
    !v.actualStartAt || !v.actualEndAt || v.actualEndAt >= v.actualStartAt,
  opts: { message: 'Фактическое окончание раньше начала', path: ['actualEndAt'] as const },
};

export const markAttendanceSchema = attendanceFactShape.refine(spanOrder.check, {
  message: spanOrder.opts.message,
  path: ['actualEndAt'],
});

/**
 * Событие ПРОПУСКНОЙ системы (порт AttendancePort): «человек прошёл турникет».
 * Опоздание считает сервер — от планового начала с допуском объекта.
 */
export const gateEventSchema = z
  .object({
    userId: z.string().uuid(),
    at: z.string().datetime(),
    direction: z.enum(['in', 'out']),
    /** id события устройства — под будущую сверку и акт */
    sourceRef: text(120).nullable().optional(),
  })
  .strict();

/** Табель объекта за период (план + внеплановые выходы) */
export const attendanceQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine((v) => v.to >= v.from, { message: 'Конец периода раньше начала', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= OBJECT_LIMITS.maxBoardDays, {
    message: `Период табеля — не больше ${OBJECT_LIMITS.maxBoardDays} дней`,
    path: ['to'],
  });

/** Правка записи факта (в том числе ВНЕПЛАНОВОЙ — её иначе не исправить) */
export const updateAttendanceSchema = attendanceFactShape
  .partial()
  .extend({ localDate: isoDate.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять')
  .refine(spanOrder.check, { message: spanOrder.opts.message, path: ['actualEndAt'] });

/** Внеплановый выход (смены в плане не было) */
export const unplannedAttendanceSchema = attendanceFactShape
  .extend({
    userId: z.string().uuid(),
    localDate: isoDate,
  })
  .strict()
  .refine(spanOrder.check, { message: spanOrder.opts.message, path: ['actualEndAt'] });

// ---------- Оборудование ----------

export const assetModelSchema = z
  .object({
    kind: assetKindEnum.default('equipment'),
    name: text(120).pipe(z.string().min(1, 'Укажите название модели')),
    manufacturer: text(120).nullable().optional(),
    category: text(80).nullable().optional(),
    glyph: text(60).nullable().optional(),
  })
  .strict();

export const updateAssetModelSchema = assetModelSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const assetModelsQuerySchema = z
  .object({
    kind: assetKindEnum.optional(),
    search: z.string().trim().max(80).optional(),
    archived: queryBoolean.optional(),
  })
  .strict();

export const createAssetSchema = z
  .object({
    /** Либо существующая модель, либо создаём на лету из формы */
    modelId: z.string().uuid().optional(),
    newModel: z
      .object({
        name: text(120).pipe(z.string().min(1, 'Укажите модель')),
        manufacturer: text(120).nullable().optional(),
        kind: assetKindEnum.optional(),
      })
      .strict()
      .optional(),
    name: text(120).pipe(z.string().min(1, 'Укажите название')),
    inventoryNumber: text(60).nullable().optional(),
    serialNumber: text(80).nullable().optional(),
    parentAssetId: z.string().uuid().nullable().optional(),
    locationNote: text(200).nullable().optional(),
    holdingKind: holdingEnum.optional(),
    balanceLegalEntityId: z.string().uuid().nullable().optional(),
    holdingCounterpartyId: z.string().uuid().nullable().optional(),
    custodianUserId: z.string().uuid().nullable().optional(),
    status: assetStatusEnum.optional(),
    purchasedOn: isoDate.nullable().optional(),
    commissionedOn: isoDate.nullable().optional(),
    warrantyUntil: isoDate.nullable().optional(),
    purchasePrice: moneySchema.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    note: text(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => !!v.modelId !== !!v.newModel, {
    message: 'Выберите модель или создайте новую',
    path: ['modelId'],
  });

export const updateAssetSchema = z
  .object({
    name: text(120).optional(),
    inventoryNumber: text(60).nullable().optional(),
    serialNumber: text(80).nullable().optional(),
    locationNote: text(200).nullable().optional(),
    purchasedOn: isoDate.nullable().optional(),
    commissionedOn: isoDate.nullable().optional(),
    warrantyUntil: isoDate.nullable().optional(),
    purchasePrice: moneySchema.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    note: text(1000).nullable().optional(),
    // sortOrder убран: список оборудования режется курсором по id, ручной порядок
    // на выдачу не влиял — поле принималось и не значило ничего.
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const moveAssetSchema = z
  .object({
    branchId: z.string().uuid().optional(),
    parentAssetId: z.string().uuid().nullable().optional(),
    locationNote: text(200).nullable().optional(),
    reason: text(200).nullable().optional(),
  })
  .strict()
  .refine((v) => v.branchId !== undefined || v.parentAssetId !== undefined, 'Укажите новое место');

export const setAssetCustodianSchema = z
  .object({
    custodianUserId: z.string().uuid().nullable(),
    reason: text(200).nullable().optional(),
  })
  .strict();

export const setAssetHoldingSchema = z
  .object({
    holdingKind: holdingEnum,
    balanceLegalEntityId: z.string().uuid().nullable().optional(),
    holdingCounterpartyId: z.string().uuid().nullable().optional(),
    reason: text(200).nullable().optional(),
  })
  .strict();

export const setAssetStatusSchema = z
  .object({
    status: assetStatusEnum,
    reason: text(200).nullable().optional(),
  })
  .strict();

export const assetServiceSchema = z
  .object({
    kind: serviceKindEnum.default('repair'),
    status: serviceStatusEnum.optional(),
    title: text(160).pipe(z.string().min(1, 'Укажите, что делали')),
    description: text(2000).nullable().optional(),
    scheduledOn: isoDate.nullable().optional(),
    startedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional(),
    nextDueOn: isoDate.nullable().optional(),
    cost: moneySchema.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    performedByUserId: z.string().uuid().nullable().optional(),
    counterpartyId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateAssetServiceSchema = assetServiceSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Нечего менять');

export const assetsQuerySchema = z
  .object({
    status: assetStatusEnum.optional(),
    /** Включить оборудование дочерних объектов */
    subtree: queryBoolean.optional(),
    search: z.string().trim().max(80).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

// ---------- Типы входа (единственный источник — схемы выше) ----------

export type CreateObjectInput = z.infer<typeof createObjectSchema>;
export type UpdateObjectInput = z.infer<typeof updateObjectSchema>;
export type MoveObjectInput = z.infer<typeof moveObjectSchema>;
export type ObjectScheduleSettingsInput = z.infer<typeof scheduleSettingsSchema>;
export type CreateStaffingPositionInput = z.infer<typeof createStaffingPositionSchema>;
export type UpdateStaffingPositionInput = z.infer<typeof updateStaffingPositionSchema>;
export type AssignToStaffingInput = z.infer<typeof assignToStaffingSchema>;
export type UpdateAttendanceInput = z.infer<typeof updateAttendanceSchema>;
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;
export type UpdateStaffingAssignmentInput = z.infer<typeof updateStaffingAssignmentSchema>;
export type CloseAssignmentInput = z.infer<typeof closeAssignmentSchema>;
export type SetRateInput = z.infer<typeof setRateSchema>;
export type ShiftTemplateInput = z.infer<typeof shiftTemplateSchema>;
export type UpdateShiftTemplateInput = z.infer<typeof updateShiftTemplateSchema>;
export type ShiftPatternInput = z.infer<typeof shiftPatternSchema>;
export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type PublishShiftsInput = z.infer<typeof publishShiftsSchema>;
export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;
export type UnplannedAttendanceInput = z.infer<typeof unplannedAttendanceSchema>;
export type GateEventInput = z.infer<typeof gateEventSchema>;
export type AssetModelInput = z.infer<typeof assetModelSchema>;
export type UpdateAssetModelInput = z.infer<typeof updateAssetModelSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type MoveAssetInput = z.infer<typeof moveAssetSchema>;
export type SetAssetCustodianInput = z.infer<typeof setAssetCustodianSchema>;
export type SetAssetHoldingInput = z.infer<typeof setAssetHoldingSchema>;
export type SetAssetStatusInput = z.infer<typeof setAssetStatusSchema>;
export type AssetServiceInput = z.infer<typeof assetServiceSchema>;
export type UpdateAssetServiceInput = z.infer<typeof updateAssetServiceSchema>;
export type AssetsQuery = z.infer<typeof assetsQuerySchema>;
