import { defineNotifications } from './types';

/**
 * Объекты: график смен. Публикация — дайджест за период (одно уведомление на
 * человека, считает продюсер); изменение смены схлопывается ПО ТИПУ в контексте
 * организации: 12 правок графика → одна строка «Изменено 12 ваших смен».
 * Оба типа организация может запереть (график — обязанность сотрудника).
 */
export const OBJECTS_NOTIFICATIONS = defineNotifications({
  'objects.shifts.published': { service: 'objects', priority: 'high', icon: 'broadcast', contexts: 'workspace', collapse: 'none', lockable: true },
  'objects.shift.changed': { service: 'objects', priority: 'high', icon: 'calendar', contexts: 'workspace', collapse: 'type', lockable: true },
  'objects.shift.taken': { service: 'objects', priority: 'normal', icon: 'userAdd', contexts: 'workspace', collapse: 'ref' },
});
