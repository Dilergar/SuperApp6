// Потолок юрлиц у организации — ключ `legalEntities.maxPerWorkspace` реестра entitlements.
export const LEGAL_ENTITY_LIMITS = {
  nameMaxLength: 160,
} as const;

export const LEGAL_ENTITY_ERROR_CODES = {
  /** Головное юрлицо нельзя архивировать/удалить — оно подставляется по умолчанию */
  head: 'legal_entity_head',
  /** БИН уже занят живым юрлицом организации */
  binDuplicate: 'legal_entity_bin_duplicate',
  /** На юрлице висят трудовые карточки/объекты/счета */
  inUse: 'legal_entity_in_use',
  /** Юрлицо в архиве — новые договоры на него не заключаются */
  archived: 'legal_entity_archived',
} as const;
