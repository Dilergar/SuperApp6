import { z } from 'zod';
import {
  APPROVAL_ASSIGNEE_TYPES,
  APPROVAL_DECISIONS,
  APPROVAL_INBOX_SCOPES,
  APPROVAL_LIMITS,
  APPROVAL_RULES,
  APPROVAL_STEP_KINDS,
} from '../constants/approvals';
import { queryBoolean } from './query';

// ============================================
// core/approvals — Zod-схемы
// ============================================

/**
 * refType — свободная строка, а не enum: движок не знает своих потребителей, и
 * закрытый список означал бы правку общего пакета на каждый новый сервис.
 * Незарегистрированный тип отсекает сам движок (400 по реестру).
 */
const refType = z.string().trim().min(1).max(64);

const title = z
  .string()
  .trim()
  .min(1, 'Укажите, что решаем')
  .max(APPROVAL_LIMITS.maxTitleLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы');

const comment = z
  .string()
  .trim()
  .max(APPROVAL_LIMITS.maxCommentLength)
  .refine((s) => !/[<>]/.test(s), 'Недопустимые символы');

/** Один шаг маршрута. Правило «каждый» имеет смысл только у должности и отдела. */
export const approvalStepInputSchema = z
  .object({
    /**
     * Группа очерёдности: одинаковый order — шаги идут одновременно. Отдельного
     * режима «последовательно/параллельно» у заявки нет, потому что это поле
     * выражает и то, и другое, а два способа сказать одно всегда разъезжаются.
     */
    order: z.coerce.number().int().min(0).max(APPROVAL_LIMITS.maxSteps),
    kind: z.enum(APPROVAL_STEP_KINDS),
    title: title.optional(),
    assigneeType: z.enum(APPROVAL_ASSIGNEE_TYPES),
    assigneeId: z.string().uuid(),
    rule: z.enum(APPROVAL_RULES).optional(),
    /** Срок решения в часах от активации шага; без него шаг ждёт бесконечно */
    dueInHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
  })
  .strict()
  .refine((s) => s.assigneeType !== 'user' || (s.rule ?? 'any') === 'any', {
    message: 'Правило «каждый» применимо к должности или отделу, а не к одному человеку',
    path: ['rule'],
  });

/**
 * POST /approvals — заводит ПОТРЕБИТЕЛЬ (Документы, позже счета и задачи).
 * Право проверяет резолвер потребителя по refType, а не эта схема.
 */
export const createApprovalSchema = z
  .object({
    refType,
    refId: z.string().uuid(),
    steps: z.array(approvalStepInputSchema).min(1).max(APPROVAL_LIMITS.maxSteps),
  })
  .strict();

/** POST /approvals/:id/steps/:stepId/decide */
export const approvalDecideSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    comment: comment.optional(),
  })
  .strict();

export const approvalInboxQuerySchema = z
  .object({
    /** Скоуп организации — сильнее `scope` */
    workspaceId: z.string().uuid().optional(),
    /**
     * `personal` — только личные заявки; без обоих полей — сквозной вид «всё, что
     * ждёт меня» (так считают верхние иконки топбара). Подробности — комментарий
     * у APPROVAL_INBOX_SCOPES.
     */
    scope: z.enum(APPROVAL_INBOX_SCOPES).optional(),
    /** Только один источник (вкладка стопки) */
    sourceKey: z.string().trim().max(64).optional(),
  })
  .strict();

export const approvalMineQuerySchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    /** Тот же скоуп, что у стопки: «мои заявки» живут рядом с ней на всех витринах */
    scope: z.enum(APPROVAL_INBOX_SCOPES).optional(),
    /** Показать закрытые заявки вместо активных */
    archived: queryBoolean.optional(),
    cursor: z.string().max(128).optional(),
  })
  .strict();

export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;
export type ApprovalStepInput = z.infer<typeof approvalStepInputSchema>;
export type ApprovalDecideInput = z.infer<typeof approvalDecideSchema>;
