import { z } from 'zod';
import { DISCOVERABLE_BY, VISIBILITY_LIMITS, VISIBILITY_PRESET_KEYS } from '../constants/visibility';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../constants/roles';
import {
  VISIBILITY_FIELD_GROUPS,
  VISIBILITY_LEVELS,
  VISIBILITY_MASK_KINDS,
  VISIBILITY_PERSONAL_AUDIENCE_KINDS,
  VISIBILITY_RELATIVE_KINDS,
  VISIBILITY_RULE_REVEAL_MODES,
  VISIBILITY_REVEAL_MODES,
  VISIBILITY_WORKSPACE_AUDIENCE_KINDS,
} from '../visibility/types';

// ============================================================
// core/visibility — входы API (Zod) + схема провода `Guarded<T>`
// ============================================================
// Правило провода (W): входные схемы принимают только `T` — маркер `Masked`/`Hidden` в
// теле правки отвергается формой, значение, похожее на маску, — сервисом.

const uuid = z.string().uuid();
const typeKey = z.string().min(1).max(64).regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/, 'validation.visibility.recordType');
const fieldKey = z.string().min(1).max(64).regex(/^[a-z][A-Za-z0-9]*$/, 'validation.visibility.fieldKey');

// ---- Провод: маркеры движка ----

export const maskedMarkerSchema = z
  .object({
    $v: z.literal('masked'),
    mask: z.enum(VISIBILITY_MASK_KINDS),
    display: z.string().max(200).nullable(),
    reveal: z.enum(VISIBILITY_REVEAL_MODES),
  })
  .strict();
export const hiddenMarkerSchema = z.object({ $v: z.literal('hidden') }).strict();

/** Схема поля `Guarded<T>` для ответов (клиенты, контрактные тесты). */
export function guarded<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, maskedMarkerSchema, hiddenMarkerSchema]);
}

// ---- Адресаты правил ----

const workspaceRoles = Object.keys(WORKSPACE_ROLES) as [WorkspaceRole, ...WorkspaceRole[]];

export const visibilityWorkspaceAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), id: z.enum(workspaceRoles) }).strict(),
  z.object({ kind: z.literal('department'), id: uuid }).strict(),
  z.object({ kind: z.literal('position'), id: uuid }).strict(),
  z.object({ kind: z.literal('branch'), id: uuid }).strict(),
  z.object({ kind: z.enum(VISIBILITY_RELATIVE_KINDS), id: z.null() }).strict(),
]);

/** Аудитория личного поля (исключения «всегда/никогда» — отдельными списками). */
export const visibilityPersonalAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everybody'), id: z.null() }).strict(),
  z.object({ kind: z.literal('circle_all'), id: z.null() }).strict(),
  z.object({ kind: z.literal('circle'), id: uuid }).strict(),
  z.object({ kind: z.literal('colleagues'), id: uuid.nullable() }).strict(),
]);
export const VISIBILITY_PERSONAL_EDITABLE_KINDS = VISIBILITY_PERSONAL_AUDIENCE_KINDS.filter((k) => k !== 'user');

// ---- Правило политики организации ----

export const visibilityRuleInputSchema = z
  .object({
    fieldKey: fieldKey.nullable().optional(),
    groupKey: z.enum(VISIBILITY_FIELD_GROUPS).nullable().optional(),
    sectionKey: fieldKey.nullable().optional(),
    audience: visibilityWorkspaceAudienceSchema,
    effect: z.enum(['allow', 'deny']),
    level: z.enum(VISIBILITY_LEVELS),
    mask: z.enum(VISIBILITY_MASK_KINDS).nullable().optional(),
    reveal: z.enum(VISIBILITY_RULE_REVEAL_MODES).optional(),
    stage: z.string().min(1).max(32).regex(/^[a-z_]+$/).nullable().optional(),
    surfaces: z.object({ inSearch: z.boolean().optional(), inPickers: z.boolean().optional() }).strict().nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((r) => [r.fieldKey, r.groupKey, r.sectionKey].filter((x) => x != null).length === 1, {
    message: 'validation.visibility.ruleTarget',
    path: ['fieldKey'],
  })
  .refine((r) => r.effect === 'allow' || r.level === 'hidden', { message: 'validation.visibility.denyLevel', path: ['level'] });
export type VisibilityRuleInput = z.infer<typeof visibilityRuleInputSchema>;

/** Замена правил черновика целиком (автосейв матрицы): черновик = набор строк. */
export const visibilityDraftInputSchema = z
  .object({
    rules: z.array(visibilityRuleInputSchema).max(VISIBILITY_LIMITS.maxRulesHard),
    /** Версия черновика, над которой правка (оптимистичная блокировка автосейва) */
    baseToken: z.string().max(64).optional(),
  })
  .strict();
export type VisibilityDraftInput = z.infer<typeof visibilityDraftInputSchema>;

export const visibilityPresetInputSchema = z.object({ preset: z.enum(VISIBILITY_PRESET_KEYS) }).strict();
export type VisibilityPresetInput = z.infer<typeof visibilityPresetInputSchema>;

export const visibilityPublishInputSchema = z
  .object({
    /** Токен черновика из диффа: публикуется ровно то, что человек видел */
    draftToken: z.string().min(1).max(64),
  })
  .strict();
export type VisibilityPublishInput = z.infer<typeof visibilityPublishInputSchema>;

export const visibilityRestoreVersionInputSchema = z.object({ version: z.number().int().min(1) }).strict();
export type VisibilityRestoreVersionInput = z.infer<typeof visibilityRestoreVersionInputSchema>;

export const workspaceVisibilitySettingsInputSchema = z
  .object({
    notifyOnReveal: z.boolean().optional(),
    dualControl: z.boolean().optional(),
    allowDelegation: z.boolean().optional(),
  })
  .strict();
export type WorkspaceVisibilitySettingsInput = z.infer<typeof workspaceVisibilitySettingsInputSchema>;

// ---- Личная политика ----

export const personalVisibilityFieldInputSchema = z
  .object({
    fieldKey,
    audiences: z.array(visibilityPersonalAudienceSchema).max(VISIBILITY_LIMITS.maxAudiencesPerField),
    always: z.array(uuid).max(VISIBILITY_LIMITS.maxExceptionsPerField).optional(),
    never: z.array(uuid).max(VISIBILITY_LIMITS.maxExceptionsPerField).optional(),
    hiddenFromCircles: z.array(uuid).max(VISIBILITY_LIMITS.maxAudiencesPerField).optional(),
  })
  .strict()
  .refine((f) => !(f.always ?? []).some((id) => (f.never ?? []).includes(id)), {
    message: 'validation.visibility.exceptionConflict',
    path: ['always'],
  });
export type PersonalVisibilityFieldInput = z.infer<typeof personalVisibilityFieldInputSchema>;

export const personalVisibilityInputSchema = z
  .object({
    fields: z.array(personalVisibilityFieldInputSchema).min(1).max(32),
  })
  .strict();
export type PersonalVisibilityInput = z.infer<typeof personalVisibilityInputSchema>;

/**
 * Редактор Группы (`/circles`): по полю — показать Группе (`true`), скрыть от Группы
 * (`false`) или «как задано в карточке» (`null`). Те же правила `circle:<id>` личной политики.
 */
export const visibilityCircleFieldsInputSchema = z
  .object({ fields: z.record(fieldKey, z.boolean().nullable()).refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 32, 'validation.visibility.fieldKey') })
  .strict();
export type VisibilityCircleFieldsInput = z.infer<typeof visibilityCircleFieldsInputSchema>;

/** Сброс поля к умолчаниям платформы. */
export const personalVisibilityResetInputSchema = z.object({ fieldKeys: z.array(fieldKey).min(1).max(32) }).strict();
export type PersonalVisibilityResetInput = z.infer<typeof personalVisibilityResetInputSchema>;

export const discoverabilityInputSchema = z.object({ discoverableBy: z.enum(DISCOVERABLE_BY) }).strict();
export type DiscoverabilityInput = z.infer<typeof discoverabilityInputSchema>;

export const visibilityPreviewQuerySchema = z
  .object({
    as: z.enum(['stranger', 'circle_all', 'circle', 'colleague', 'user']),
    id: uuid.optional(),
  })
  .strict()
  .refine((q) => (q.as === 'circle' || q.as === 'colleague' || q.as === 'user' ? !!q.id : !q.id), {
    message: 'validation.visibility.previewTarget',
    path: ['id'],
  });
export type VisibilityPreviewQuery = z.infer<typeof visibilityPreviewQuerySchema>;

/** Анкета организации глазами роли (`GET /workspaces/:id/card-preview?role=`): владелец/админ. */
export const workspaceCardPreviewQuerySchema = z.object({ role: z.enum(workspaceRoles) }).strict();
export type WorkspaceCardPreviewQuery = z.infer<typeof workspaceCardPreviewQuerySchema>;

// ---- План, объяснение, раскрытие ----

export const visibilityPlanQuerySchema = z.object({ recordType: typeKey }).strict();
export type VisibilityPlanQuery = z.infer<typeof visibilityPlanQuerySchema>;

export const visibilityExplainQuerySchema = z
  .object({
    recordType: typeKey,
    viewerId: uuid,
    /** Субъект записи — для относительных адресатов и «сам» */
    subjectId: uuid.optional(),
  })
  .strict();
export type VisibilityExplainQuery = z.infer<typeof visibilityExplainQuerySchema>;

export const visibilityRevealInputSchema = z
  .object({
    recordType: typeKey,
    recordId: z.string().min(1).max(64),
    fields: z.array(fieldKey).min(1).max(VISIBILITY_LIMITS.maxRevealFields),
  })
  .strict();
export type VisibilityRevealInput = z.infer<typeof visibilityRevealInputSchema>;

export const visibilityStepUpConfirmSchema = z
  .object({ verifyToken: z.string().regex(/^[a-f0-9]{64}$/, 'validation.auth.verifyToken') })
  .strict();
export type VisibilityStepUpConfirmInput = z.infer<typeof visibilityStepUpConfirmSchema>;

export const visibilityVersionsQuerySchema = z.object({ recordType: typeKey }).strict();
