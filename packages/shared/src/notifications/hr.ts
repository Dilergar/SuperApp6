import { defineNotifications } from './types';

/**
 * КЭДО (modules/hr). Сроки закона (вручение акта, ЕСУТД, срочный договор) —
 * критичны: пропуск = нарушение ТК, отключить нельзя, SMS по opt-in.
 */
export const HR_NOTIFICATIONS = defineNotifications({
  'hr.action.applied': { service: 'hr', priority: 'high', icon: 'staff', contexts: 'workspace', collapse: 'ref' },
  'hr.action.failed': { service: 'hr', priority: 'high', icon: 'warningCircle', contexts: 'workspace', collapse: 'ref' },
  'hr.action.withdrawn': { service: 'hr', priority: 'high', icon: 'undo', contexts: 'workspace', collapse: 'ref' },
  'hr.esutd.due_soon': { service: 'hr', priority: 'critical', icon: 'clock', contexts: 'workspace', collapse: 'ref', smsEligible: true },
  'hr.campaign.assigned': { service: 'hr', priority: 'high', icon: 'file', contexts: 'workspace', collapse: 'ref', lockable: true },
  'hr.campaign.reminder': { service: 'hr', priority: 'high', icon: 'bellRinging', contexts: 'workspace', collapse: 'ref', lockable: true },
  'hr.campaign.done': { service: 'hr', priority: 'normal', icon: 'finish', contexts: 'workspace', collapse: 'ref' },
  'hr.delivery.due': { service: 'hr', priority: 'critical', icon: 'mail', contexts: 'workspace', collapse: 'ref', smsEligible: true },
  'hr.probation.ending': { service: 'hr', priority: 'high', icon: 'hourglass', contexts: 'workspace', collapse: 'ref' },
  'hr.contract.expiring': { service: 'hr', priority: 'critical', icon: 'calendar', contexts: 'workspace', collapse: 'ref', smsEligible: true },
});
