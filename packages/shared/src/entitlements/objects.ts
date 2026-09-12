import { defineEntitlements } from './types';

/** Объекты: узлов дерева площадок на организацию. */
export const OBJECTS_ENTITLEMENTS = defineEntitlements({
  'objects.maxPerWorkspace': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 2000,
    hasUsage: true,
    service: 'objects',
    labelKey: 'entitlements.keys.objectsMaxPerWorkspace',
  },
});
