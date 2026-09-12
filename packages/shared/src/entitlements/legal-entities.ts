import { defineEntitlements } from './types';

/** Юрлица (ТОО/ИП) внутри организации. */
export const LEGAL_ENTITIES_ENTITLEMENTS = defineEntitlements({
  'legalEntities.maxPerWorkspace': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 20,
    hasUsage: true,
    service: 'legalEntities',
    labelKey: 'entitlements.keys.legalEntitiesMaxPerWorkspace',
  },
});
