import { defineEntitlements } from './types';

const GB = 1024 * 1024 * 1024;

/**
 * Диск: место на владельца файлов. Квота БЕЗ периода (байты живут, пока живёт
 * файл), счётчик — `QuotaCounter` (обобщение прежнего `FileQuotaUsage`).
 * Профили доказательств подписи (core/sign) в квоту не входят нигде.
 */
export const FILES_ENTITLEMENTS = defineEntitlements({
  'files.storageBytes': {
    kind: 'quota',
    carrier: 'container',
    subjects: ['user', 'workspace'],
    unit: 'bytes',
    defaultFree: { user: 15 * GB, workspace: 100 * GB },
    hasUsage: true,
    service: 'files',
    labelKey: 'entitlements.keys.filesStorageBytes',
  },
  // Число файлов: сегодня без ограничения (null), но счётчик ведётся тем же путём —
  // ступень сможет ограничить его без правок кода.
  'files.count': {
    kind: 'quota',
    carrier: 'container',
    subjects: ['user', 'workspace'],
    unit: 'count',
    defaultFree: null,
    hasUsage: true,
    service: 'files',
    labelKey: 'entitlements.keys.filesCount',
  },
});
