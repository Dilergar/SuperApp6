import { defineEntitlements } from './types';

/** Окружение: число Групп у владельца. */
export const CONTACTS_ENTITLEMENTS = defineEntitlements({
  'contacts.maxCircles': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['user'],
    unit: 'count',
    defaultFree: 50,
    hasUsage: true,
    service: 'contacts',
    labelKey: 'entitlements.keys.contactsMaxCircles',
  },
});
