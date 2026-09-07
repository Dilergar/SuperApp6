import { defineNotifications } from './types';

/**
 * Организации (членство, роли, должности). Приглашение приходит НЕ-члену — строка
 * ложится в «Личное» (контекст строки — по членству адресата), поэтому сервис `both`.
 */
export const WORKSPACES_NOTIFICATIONS = defineNotifications({
  'workspace.invitation.received': { service: 'workspaces', priority: 'high', icon: 'workspace', contexts: 'both', collapse: 'none' },
  'workspace.invitation.accepted': { service: 'workspaces', priority: 'high', icon: 'userAdd', contexts: 'both', collapse: 'none' },
  'workspace.invitation.rejected': { service: 'workspaces', priority: 'normal', icon: 'blocked', contexts: 'both', collapse: 'none' },
  'workspace.member.removed': { service: 'workspaces', priority: 'high', icon: 'door', contexts: 'both', collapse: 'none' },
  'workspace.role.changed': { service: 'workspaces', priority: 'high', icon: 'crown', contexts: 'both', collapse: 'none' },
  'workspace.position.assigned': { service: 'workspaces', priority: 'high', icon: 'position', contexts: 'both', collapse: 'none' },
  'workspace.position.certified': { service: 'workspaces', priority: 'high', icon: 'graduation', contexts: 'both', collapse: 'none' },
  // Архив: предупреждения за 7 / 3 / 1 день до полного удаления — владельцу; неотключаемо
  'workspace.archive.expiring': { service: 'workspaces', priority: 'critical', icon: 'archive', contexts: 'both', collapse: 'ref', smsEligible: true },
});
