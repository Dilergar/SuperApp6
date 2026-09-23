import { defineEntitlements } from './types';

/**
 * Журнал безопасности организации (core/audit). ПОЛНОТА записи от тарифа не зависит
 * никогда (Storm-0558: журнал безопасности бесплатен на всех тарифах) — тариф решает только
 * окно ПРОСМОТРА организацией, выгрузку и стрим во внешний SIEM. Сессии, устройства, «выйти
 * везде», «Это не я» и заморозка — у человека бесплатно всегда.
 */
export const AUDIT_ENTITLEMENTS = defineEntitlements({
  /** Окно журнала организации (дни): free 90 · basic 180 · standard 365 · pro 1095 */
  'audit.retentionDays': {
    kind: 'config',
    carrier: 'container',
    subjects: ['workspace'],
    unit: 'count',
    defaultFree: 90,
    hasUsage: false,
    service: 'audit',
    labelKey: 'entitlements.keys.auditRetentionDays',
  },
  /** Выгрузка журнала организации (NDJSON/CSV на Диск) — с basic */
  'audit.export': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'audit',
    labelKey: 'entitlements.keys.auditExport',
  },
  /** Стрим событий безопасности во внешний SIEM через вебхуки организации — со standard */
  'audit.stream': {
    kind: 'feature',
    carrier: 'container',
    subjects: ['workspace'],
    defaultFree: false,
    hasUsage: false,
    service: 'audit',
    labelKey: 'entitlements.keys.auditStream',
  },
});
