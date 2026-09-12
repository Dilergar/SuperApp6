import { defineEntitlements } from './types';

/**
 * Скины карточек: разный скин на каждую Группу — свойство ЧЕЛОВЕКА (carrier
 * person): виден во всех контекстах. Заменяет прежнее поле `User.premiumUntil`
 * (перенесено грантом `source='legacy'`).
 */
export const CARD_SKINS_ENTITLEMENTS = defineEntitlements({
  'skins.perGroup': {
    kind: 'feature',
    carrier: 'person',
    subjects: ['user'],
    defaultFree: false,
    hasUsage: false,
    service: 'cardSkins',
    labelKey: 'entitlements.keys.skinsPerGroup',
  },
});
