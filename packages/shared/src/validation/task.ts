import { z } from 'zod';
import { ALLOWED_RECURRENCE_RULES, TASK_LIMITS } from '../constants/tasks';

const noHtml = (s: string) => !/[<>]/.test(s);

const taskStatusEnum = z.enum(['todo', 'in_progress', 'on_review', 'done', 'cancelled']);
const taskPriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);

const titleSchema = z
  .string()
  .min(1, 'Название задачи обязательно')
  .max(TASK_LIMITS.maxTitleLength)
  .refine(noHtml, 'Недопустимые символы');

const descriptionSchema = z
  .string()
  .max(TASK_LIMITS.maxDescriptionLength)
  .refine(noHtml, 'Недопустимые символы');

const tagSchema = z
  .string()
  .min(1)
  .max(TASK_LIMITS.maxTagLength)
  .refine(noHtml, 'Недопустимые символы');

const recurrenceSchema = z
  .string()
  .refine((r) => ALLOWED_RECURRENCE_RULES.includes(r), 'Неподдерживаемое повторение');

const coinSchema = z.number().int().min(0).max(TASK_LIMITS.maxCoinReward);

export const createTaskSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.optional(),
    priority: taskPriorityEnum.optional().default('medium'),

    dueDate: z.string().datetime().optional(),
    startDate: z.string().datetime().optional(),
    allDay: z.boolean().optional().default(false),
    reminderAt: z.string().datetime().optional(),
    recurrenceRule: recurrenceSchema.optional(),

    // Assignment: EITHER individual (executorId) OR group (assignedCircleId), not both.
    executorId: z.string().uuid().optional(),
    coExecutorIds: z.array(z.string().uuid()).max(TASK_LIMITS.maxCoExecutors).optional(),
    observerIds: z.array(z.string().uuid()).max(TASK_LIMITS.maxObservers).optional(),
    assignedCircleId: z.string().uuid().optional(),

    parentId: z.string().uuid().optional(),

    // «Входящие»: quick-add себе. Сервис гасит флаг, если задан срок/исполнитель/родитель.
    inbox: z.boolean().optional().default(false),

    coinReward: coinSchema.optional().default(0),
    coinPenalty: coinSchema.optional().default(0),
    giftRewardId: z.string().uuid().optional(),

    tags: z.array(tagSchema).max(TASK_LIMITS.maxTags).optional(),
    workspaceId: z.string().uuid().optional(),
    addToCalendar: z.boolean().optional().default(false),
    // Вложения «с порога» (файлы уже загружены движком до создания задачи)
    attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict()
  .refine((d) => !(d.executorId && d.assignedCircleId), {
    message: 'Нельзя одновременно назначить Исполнителя и Группу',
    path: ['assignedCircleId'],
  })
  .refine((d) => !(d.assignedCircleId && d.coExecutorIds?.length), {
    message: 'При назначении на Группу Соисполнители берутся из неё',
    path: ['coExecutorIds'],
  });

/** POST /tasks/:id/attachments — прикрепить файл движка к задаче */
export const attachTaskFileSchema = z
  .object({
    fileId: z.string().uuid(),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    dueDate: z.string().datetime().nullable().optional(),
    startDate: z.string().datetime().nullable().optional(),
    allDay: z.boolean().optional(),
    reminderAt: z.string().datetime().nullable().optional(),
    recurrenceRule: recurrenceSchema.nullable().optional(),
    coinReward: coinSchema.optional(),
    coinPenalty: coinSchema.optional(),
    tags: z.array(tagSchema).max(TASK_LIMITS.maxTags).optional(),
    // Ручное «Разобрано» для «Входящих» (уточнение срока/исполнителя гасит флаг само).
    inbox: z.boolean().optional(),

    // Role edits (creator only — enforced in the service)
    executorId: z.string().uuid().nullable().optional(),
    addCoExecutorIds: z.array(z.string().uuid()).max(TASK_LIMITS.maxCoExecutors).optional(),
    addObserverIds: z.array(z.string().uuid()).max(TASK_LIMITS.maxObservers).optional(),
    removeParticipantUserIds: z.array(z.string().uuid()).max(200).optional(),
  })
  .strict();

export const taskFilterSchema = z.object({
  status: z.array(taskStatusEnum).optional(),
  priority: z.array(taskPriorityEnum).optional(),
  role: z.enum(['creator', 'executor', 'co_executor', 'observer']).optional(),
  smartList: z
    .enum(['inbox', 'today', 'upcoming', 'overdue', 'assigned_to_me', 'created_by_me', 'on_review'])
    .optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  dueDateFrom: z.string().datetime().optional(),
  dueDateTo: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().max(200).refine(noHtml, 'Недопустимые символы').optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// Submit / accept / return. For a group task the creator targets one co_executor via
// participantUserId; an executor acting on their own part omits it.
export const taskParticipantActionSchema = z
  .object({
    participantUserId: z.string().uuid().optional(),
  })
  .strict();
