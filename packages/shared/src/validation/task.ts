import { z } from 'zod';

const taskStatusEnum = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const taskPriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Название задачи обязательно').max(500),
  description: z.string().max(5000).optional(),
  priority: taskPriorityEnum.optional().default('medium'),
  dueDate: z.string().datetime().optional(),
  startDate: z.string().datetime().optional(),
  assigneeId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  coinReward: z.number().int().min(0).max(10000).optional().default(0),
  coinPenalty: z.number().int().min(0).max(10000).optional().default(0),
  tags: z.array(z.string().max(50)).max(20).optional(),
  workspaceId: z.string().uuid().optional(),
  addToCalendar: z.boolean().optional().default(false),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  coinReward: z.number().int().min(0).max(10000).optional(),
  coinPenalty: z.number().int().min(0).max(10000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const taskFilterSchema = z.object({
  status: z.array(taskStatusEnum).optional(),
  priority: z.array(taskPriorityEnum).optional(),
  assigneeId: z.string().uuid().optional(),
  creatorId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  dueDateFrom: z.string().datetime().optional(),
  dueDateTo: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().max(200).optional(),
});
