import { defineEntitlements } from './types';

/**
 * Организации: места (член trainee+ занимает место; подрядчики и гости — нет) и
 * число организаций, которыми человек владеет. Значения по умолчанию — прежние
 * константы `WORKSPACE_LIMITS` (удалены оттуда: второго источника у сетки нет).
 */
export const WORKSPACES_ENTITLEMENTS = defineEntitlements({
  'workspace.seats': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 1000,
    hasUsage: true,
    service: 'workspaces',
    labelKey: 'entitlements.keys.workspaceSeats',
  },
  'workspaces.maxOwned': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['user'],
    unit: 'count',
    defaultFree: 20,
    hasUsage: true,
    service: 'workspaces',
    labelKey: 'entitlements.keys.workspacesMaxOwned',
  },
});
