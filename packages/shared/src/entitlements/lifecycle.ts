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
  /**
   * Потолок срока хранения класса данных, который может выбрать организация (глубина
   * истории — рычаг тарифа, Slack). `limit` без счётчика: MAX грантов, null — без потолка
   * («вечно»). Ограничивает ВЫБОР (коридор при сохранении → 402 с unlock); ретроактивно
   * не режет — смена тарифа молча данные не удаляет. Свободное значение null у всех
   * планов: в день запуска поведение продукта не меняется.
   */
  'lifecycle.retention.user_content_shared.ceilingDays': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: null,
    hasUsage: false,
    service: 'lifecycle',
    labelKey: 'entitlements.keys.lifecycleRetentionMessages',
  },
  'lifecycle.retention.tenant_record.ceilingDays': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: null,
    hasUsage: false,
    service: 'lifecycle',
    labelKey: 'entitlements.keys.lifecycleRetentionRecords',
  },
  'lifecycle.retention.operational.ceilingDays': {
    kind: 'limit',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: null,
    hasUsage: false,
    service: 'lifecycle',
    labelKey: 'entitlements.keys.lifecycleRetentionIntegrations',
  },
});
