import { defineNotifications } from './types';

/**
 * Процессы. Нода «Уведомить» — программируемый продюсер: шлёт с бюджетом
 * организации (`budget: 'workspace'`), сверх — `notification.rateLimited`.
 * `ref` = экземпляр процесса (`process_instance`).
 */
export const PROCESSES_NOTIFICATIONS = defineNotifications({
  'process.finished': { service: 'processes', priority: 'normal', icon: 'finish', contexts: 'workspace', collapse: 'ref' },
  'process.failed': { service: 'processes', priority: 'high', icon: 'warningCircle', contexts: 'workspace', collapse: 'ref' },
  'process.step.notify': { service: 'processes', priority: 'high', icon: 'bell', contexts: 'workspace', collapse: 'none' },
  'process.approval.requested': { service: 'processes', priority: 'high', icon: 'checkCircle', contexts: 'workspace', collapse: 'ref', lockable: true },
  'process.task.queued': { service: 'processes', priority: 'high', icon: 'pending', contexts: 'workspace', collapse: 'ref' },
  'process.step.overdue': { service: 'processes', priority: 'high', icon: 'overdue', contexts: 'workspace', collapse: 'ref' },
});
