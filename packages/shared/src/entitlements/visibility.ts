import { defineEntitlements } from './types';

/**
 * Правила видимости (core/visibility). Решение грилла №11: ТАРИФ ОГРАНИЧИВАЕТ НАСТРОЙКУ,
 * А НЕ ЗАЩИТУ — умолчания, маски, раскрытие владельцем/админом с журналом и правила по
 * лестнице ролей есть у всех; со `business_standard` — адресаты оргструктуры в матрице,
 * делегирование раскрытия, «Посмотреть как» и пресеты. Снятие тарифа маски не выключает.
 */
export const VISIBILITY_ENTITLEMENTS = defineEntitlements({
  /** Столбцы матрицы «отдел / должность / объект» — со standard */
  'visibility.orgAudiences': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityOrgAudiences',
  },
  /** Делегирование раскрытия адресатам оргструктуры — со standard */
  'visibility.revealDelegation': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityRevealDelegation',
  },
  /** «Проверить сотрудника» (объяснение плана любого зрителя) — со standard */
  'visibility.explain': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityExplain',
  },
  /** Пресеты политики (Розница / Офис / Строгий) — со standard */
  'visibility.presets': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityPresets',
  },
  /** Правил во всех политиках организации: free 50 · basic 200 · standard 1000 · pro 5000 */
  'visibility.maxRules': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 50,
    hasUsage: true,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityMaxRules',
  },
  /**
   * Раскрытий в сутки на человека — антискрейпинг (едет с человеком: раскрывающий один и
   * тот же, в какой бы организации он ни был).
   */
  'visibility.revealsPerDay': {
    kind: 'quota',
    carrier: 'person',
    subjects: ['user'],
    unit: 'count',
    period: 'day',
    defaultFree: 100,
    hasUsage: true,
    service: 'visibility',
    labelKey: 'entitlements.keys.visibilityRevealsPerDay',
  },
});
