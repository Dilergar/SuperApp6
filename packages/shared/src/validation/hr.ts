import { z } from 'zod';
import {
  CAMPAIGN_FIX_MODES,
  CAMPAIGN_MODES,
  CONTRACT_TYPES,
  DISMISSAL_GROUNDS,
  DOC_DELIVERY_METHODS,
  DOC_DELIVERY_MODES,
  HR_ACTION_KINDS,
} from '../constants/hr';

// ============================================================
// КЭДО (modules/hr) — Zod. Тонкий контроллер: parse → сервис (AI-ready).
// ============================================================

const safeText = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), { message: 'Символы < и > запрещены' });

/** Кадровые даты — КАЛЕНДАРНЫЕ (YYYY-MM-DD), без часовых поясов */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

const kindEnum = z.enum(HR_ACTION_KINDS.map((k) => k.value) as [string, ...string[]]);
const contractTypeEnum = z.enum(CONTRACT_TYPES.map((c) => c.value) as [string, ...string[]]);
const groundEnum = z.enum(DISMISSAL_GROUNDS.map((g) => g.value) as [string, ...string[]]);

/** Оклад приходит ЦЕЛЫМИ ТИЫНАМИ (снимок в BigInt-колонку) */
const salarySchema = z.number().int().min(0).max(1_000_000_000_000);

// ---------- Трудовая карточка ----------

export const upsertEmploymentSchema = z.object({
  hiredAt: isoDate.nullable().optional(),
  contractNumber: safeText(60).nullable().optional(),
  contractDate: isoDate.nullable().optional(),
  contractType: contractTypeEnum.optional(),
  contractEndAt: isoDate.nullable().optional(),
  contractExtensionsCount: z.number().int().min(0).max(20).optional(),
  probationUntil: isoDate.nullable().optional(),
  legalPositionId: z.string().uuid().nullable().optional(),
  legalBranchId: z.string().uuid().nullable().optional(),
  workRate: z.number().min(0.05).max(2).nullable().optional(),
  workSchedule: safeText(120).nullable().optional(),
  salaryAmount: salarySchema.nullable().optional(),
  salaryCurrency: z.string().trim().length(3).optional(),
  paperMode: z.boolean().optional(),
  personnelNumber: safeText(40).nullable().optional(),
});

// ---------- Кадровые действия ----------

/**
 * Параметры действия — по виду. Держим ОДНИМ объектом с необязательными полями,
 * а не discriminated union: параметры дополняют друг друга (перевод может нести
 * и новый оклад), сервис проверяет обязательное для своего вида.
 */
export const hrActionParamsSchema = z
  .object({
    // dismissal
    ground: groundEnum.optional(),
    /** Подтверждение исключения ст. 54 (основание вне справочника) — осознанный шаг */
    banExceptionConfirmed: z.boolean().optional(),
    /** «И то и другое»: при применении увольнения снять и членство в организации */
    alsoRemoveMembership: z.boolean().optional(),
    // transfer
    legalPositionId: z.string().uuid().optional(),
    legalBranchId: z.string().uuid().nullable().optional(),
    /** Применение перевода СИНХРОНИЗИРУЕТ факт (StaffAssignment) — галочка в модалке */
    syncFact: z.boolean().optional(),
    // salary_change (и hire, и transfer)
    salaryAmount: salarySchema.optional(),
    salaryCurrency: z.string().trim().length(3).optional(),
    // leave
    leaveType: z.enum(['paid', 'unpaid']).optional(),
    // hire
    contractType: contractTypeEnum.optional(),
    contractNumber: safeText(60).optional(),
    contractDate: isoDate.optional(),
    contractEndAt: isoDate.optional(),
    probationUntil: isoDate.optional(),
    workRate: z.number().min(0.05).max(2).optional(),
    workSchedule: safeText(120).optional(),
    paperMode: z.boolean().optional(),
    personnelNumber: safeText(40).optional(),
  })
  .strict();

/** Период действия не может кончаться раньше, чем начался (отпуск «с 20-го по 5-е») */
const periodOk = (v: { effectiveAt: string; effectiveTo?: string }) => !v.effectiveTo || v.effectiveTo >= v.effectiveAt;
const periodMessage = { message: 'Дата окончания не может быть раньше даты начала', path: ['effectiveTo'] };

export const createHrActionSchema = z.object({
  kind: kindEnum,
  userId: z.string().uuid(),
  effectiveAt: isoDate,
  effectiveTo: isoDate.optional(),
  /** Шаблон ПРИКАЗА (у него обязан быть опубликованный маршрут с нодой hr.apply) */
  templateId: z.string().uuid(),
  /** Онбординг-пакет приёма: дополнительные документы (договор, согласие на ПД…) */
  packageTemplateIds: z.array(z.string().uuid()).max(10).optional(),
  params: hrActionParamsSchema.optional(),
  /** Значения формы подачи шаблона приказа */
  fields: z.record(z.unknown()).optional(),
}).refine(periodOk, periodMessage);

export const createHrBatchSchema = z.object({
  /** Массовый приём не поддерживается — у приёма индивидуальный пакет */
  kind: z.enum(
    HR_ACTION_KINDS.map((k) => k.value).filter((v) => v !== 'hire') as [string, ...string[]],
  ),
  audience: z
    .array(
      z.object({
        type: z.enum(['user', 'position', 'department', 'branch', 'workspace']),
        id: z.string().uuid(),
      }),
    )
    .min(1)
    .max(50),
  effectiveAt: isoDate,
  effectiveTo: isoDate.optional(),
  templateId: z.string().uuid(),
  params: hrActionParamsSchema.optional(),
  fields: z.record(z.unknown()).optional(),
}).refine(periodOk, periodMessage);

// ---------- ЕСУТД ----------

export const esutdMarkSubmittedSchema = z.object({
  externalNumber: safeText(80).optional(),
});

// ---------- Вручение ----------

export const docDeliverySchema = z.object({
  method: z.enum(DOC_DELIVERY_METHODS.map((m) => m.value) as [string, ...string[]]),
  trackNumber: safeText(60).optional(),
  /** Момент вручения; пусто — сейчас */
  deliveredAt: z.string().datetime().optional(),
});

export const docDeliveryModeSchema = z.object({
  deliveryMode: z.enum(DOC_DELIVERY_MODES.map((m) => m.value) as [string, ...string[]]),
});

// ---------- Кампании ознакомления ----------

export const createCampaignSchema = z.object({
  orgDocumentId: z.string().uuid(),
  title: safeText(200).optional(),
  mode: z.enum(CAMPAIGN_MODES.map((m) => m.value) as [string, ...string[]]).optional(),
  fixMode: z.enum(CAMPAIGN_FIX_MODES.map((m) => m.value) as [string, ...string[]]).optional(),
  audience: z
    .array(
      z.object({
        type: z.enum(['user', 'position', 'department', 'branch', 'workspace']),
        id: z.string().uuid(),
      }),
    )
    .min(1)
    .max(50),
  dueAt: isoDate.optional(),
});

// ---------- Библиотека кадровых бланков ----------

/**
 * Мастер установки спрашивает подписанта организации ОДИН раз и проставляет его
 * во все маршруты, публикуя их сразу: маршрут-черновик, который менеджер забыл
 * донастроить, — это действие, которое никогда не применится.
 */
export const hrLibraryInstallSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    signerUserId: z.string().uuid().optional(),
    signerPositionId: z.string().uuid().optional(),
  })
  .refine((v) => !!v.signerUserId || !!v.signerPositionId, {
    message: 'Укажите подписанта: человека или должность',
  });

export type UpsertEmploymentInput = z.infer<typeof upsertEmploymentSchema>;
export type HrActionParamsInput = z.infer<typeof hrActionParamsSchema>;
export type CreateHrActionInput = z.infer<typeof createHrActionSchema>;
export type CreateHrBatchInput = z.infer<typeof createHrBatchSchema>;
export type EsutdMarkSubmittedInput = z.infer<typeof esutdMarkSubmittedSchema>;
export type DocDeliveryInput = z.infer<typeof docDeliverySchema>;
export type DocDeliveryModeInput = z.infer<typeof docDeliveryModeSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type HrLibraryInstallInput = z.infer<typeof hrLibraryInstallSchema>;
