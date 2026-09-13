import { z } from 'zod';
import { defineAnalyticsEvents, noProps } from './types';

// ============================================================
// Задачник — факты сервера из транзакций мутаций
// ============================================================

export const TASKS_ANALYTICS_EVENTS = defineAnalyticsEvents({
  'tasks.task.created': {
    service: 'tasks',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: z
      .object({
        hasAssignee: z.boolean(),
        hasDue: z.boolean(),
        hasReward: z.boolean(),
        contextType: z.enum(['personal', 'workspace']),
      })
      .strict(),
    version: 1,
    status: 'live',
  },
  /** Задача без приёмки завершена: личная (без участников) либо постановщик сам себе исполнитель */
  'tasks.task.completed': {
    service: 'tasks',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'tasks.task.submitted': {
    service: 'tasks',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
  'tasks.task.accepted': {
    service: 'tasks',
    source: 'server',
    class: 'business',
    qualifying: true,
    props: noProps(),
    version: 1,
    status: 'live',
  },
});
