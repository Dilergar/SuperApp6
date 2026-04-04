import { z } from 'zod';
import { phoneSchema } from './auth';

export const createCircleSchema = z.object({
  name: z.string().min(1, 'Название окружения обязательно').max(100),
  icon: z.string().max(10).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const addCircleMemberSchema = z.object({
  contactPhone: phoneSchema,
  contactName: z.string().min(1, 'Имя контакта обязательно').max(100),
  role: z.string().min(1, 'Роль обязательна').max(50),
});

export const updateCircleMemberSchema = z.object({
  contactName: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(50).optional(),
});
