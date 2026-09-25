import { defineEntitlements } from './types';

/**
 * Жизненный цикл данных организации (core/lifecycle). Удаление по сроку, стирание человека и
 * заморозка ПЛАТФОРМЫ от тарифа не зависят никогда (обязанность, а не услуга) — тариф решает
 * только инструменты организации.
 */
export const LIFECYCLE_ENTITLEMENTS = defineEntitlements({
  /** Заморозки (legal hold) организацией: хранитель, чат, запись, класс данных — со standard */
  'lifecycle.holds': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'lifecycle',
    labelKey: 'entitlements.keys.lifecycleHolds',
  },
});
