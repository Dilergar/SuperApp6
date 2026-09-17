import { defineEntitlements } from './types';

/**
 * Ключи и вебхуки (core/keys, core/webhooks): боты организации, личные ключи
 * человека, endpoint'ы вебхуков организации. Потолки — только здесь, не в константах.
 */
export const KEYS_ENTITLEMENTS = defineEntitlements({
  'keys.maxBots': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 10,
    hasUsage: true,
    service: 'keys',
    labelKey: 'entitlements.keys.keysMaxBots',
  },
  'keys.maxPersonalTokens': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['user'],
    unit: 'count',
    defaultFree: 5,
    hasUsage: true,
    service: 'keys',
    labelKey: 'entitlements.keys.keysMaxPersonalTokens',
  },
  'webhooks.maxEndpoints': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 5,
    hasUsage: true,
    service: 'keys',
    labelKey: 'entitlements.keys.webhooksMaxEndpoints',
  },
});
