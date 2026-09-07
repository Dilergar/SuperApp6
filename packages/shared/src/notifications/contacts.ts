import { defineNotifications } from './types';

/** Окружение (Circle): приглашения и связи. Личный контекст. */
export const CONTACTS_NOTIFICATIONS = defineNotifications({
  'contact.invitation.received': { service: 'contacts', priority: 'high', icon: 'userAdd', contexts: 'personal', collapse: 'none' },
  'contact.invitation.accepted': { service: 'contacts', priority: 'normal', icon: 'checkCircle', contexts: 'personal', collapse: 'none' },
  'contact.invitation.rejected': { service: 'contacts', priority: 'normal', icon: 'blocked', contexts: 'personal', collapse: 'none' },
  'contact.invitation.cancelled': { service: 'contacts', priority: 'normal', icon: 'undo', contexts: 'personal', collapse: 'none' },
  // TTL вышел — говорим ОТПРАВИТЕЛЮ: иначе он узнаёт, только заглянув в список
  'contact.invitation.expired': { service: 'contacts', priority: 'normal', icon: 'hourglass', contexts: 'personal', collapse: 'none' },
  'contact.linked': { service: 'contacts', priority: 'normal', icon: 'handshake', contexts: 'personal', collapse: 'none' },
  'contact.removed': { service: 'contacts', priority: 'normal', icon: 'remove', contexts: 'personal', collapse: 'none' },
});
