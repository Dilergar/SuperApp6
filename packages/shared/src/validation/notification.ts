import { z } from 'zod';

/**
 * Тело `POST /notifications/mark-read`. До 2026-08-07 это была ЕДИНСТВЕННАЯ ручка
 * платформы, принимавшая тело без Zod (`@Body() body: { notificationIds?: string[] }`),
 * то есть без валидации вовсе. Пустой список = «прочитать все».
 */
export const markNotificationsReadSchema = z
  .object({
    notificationIds: z.array(z.string().min(1)).max(500).optional(),
  })
  .strict();

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;
