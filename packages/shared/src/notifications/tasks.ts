import { defineNotifications } from './types';

/** Задачник. `ref` = задача (`task`), схлопывание по задаче: три правки одной задачи — одна строка. */
export const TASKS_NOTIFICATIONS = defineNotifications({
  'task.assigned': { service: 'tasks', priority: 'high', icon: 'tasks', contexts: 'both', collapse: 'ref' },
  'task.submitted': { service: 'tasks', priority: 'high', icon: 'send', contexts: 'both', collapse: 'ref' },
  'task.accepted': { service: 'tasks', priority: 'high', icon: 'checkCircle', contexts: 'both', collapse: 'ref' },
  'task.returned': { service: 'tasks', priority: 'high', icon: 'undo', contexts: 'both', collapse: 'ref' },
  'task.completed': { service: 'tasks', priority: 'normal', icon: 'check', contexts: 'both', collapse: 'ref' },
  'task.due_soon': { service: 'tasks', priority: 'high', icon: 'clock', contexts: 'both', collapse: 'ref' },
  'task.overdue': { service: 'tasks', priority: 'high', icon: 'overdue', contexts: 'both', collapse: 'ref' },
});
