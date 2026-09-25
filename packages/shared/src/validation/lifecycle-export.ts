import { z } from 'zod';

// ============================================================
// Выгрузки данных (core/lifecycle Э6): архив человека и организации, архив восстановления
// ============================================================
// Два вида одной упаковки (`manifest.json` + `data/<политика>.<n>.jsonl` + `files/…`):
//  - `portable` — человеку и владельцу организации (переносимость, ст. 20 GDPR / Google Takeout):
//    читаемые строки без секретов, ПДн в открытом виде, поля под правилами видимости — глазами
//    заказчика, без удалённого и вне срока; ZIP-частями на скачивание; НЕ импортируется;
//  - `restore` — только Кабинет (восстановление арендатора из бэкапа): строки как есть, манифест
//    подписан платформой (Ed25519, аудитория `lifecycle`); объекты в хранилище, импорт — только его.

export const LIFECYCLE_EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type LifecycleExportStatus = (typeof LIFECYCLE_EXPORT_STATUSES)[number];

export const LIFECYCLE_EXPORT_MODES = ['portable', 'restore'] as const;
export type LifecycleExportMode = (typeof LIFECYCLE_EXPORT_MODES)[number];

export const LIFECYCLE_EXPORT_SUBJECTS = ['user', 'workspace'] as const;
export type LifecycleExportSubjectType = (typeof LIFECYCLE_EXPORT_SUBJECTS)[number];

/** Фазы сборки: сбор строк по политикам → упаковка частей → манифест. */
export const LIFECYCLE_EXPORT_PHASES = ['collect', 'package', 'finish'] as const;
export type LifecycleExportPhase = (typeof LIFECYCLE_EXPORT_PHASES)[number];

/**
 * Коды провала сборки (`errorCode`): `owner_mismatch` — перепроверка владельца нашла чужую
 * строку (Google Takeout 2019: чужие видео в архиве) — сборка останавливается целиком;
 * `too_large` — архив не уложился в предел; `quota` — суточная квота организации;
 * `subject_gone` — субъекта больше нет (удалён, организация в архиве); `internal` — прочее.
 */
export const LIFECYCLE_EXPORT_ERRORS = ['owner_mismatch', 'too_large', 'quota', 'subject_gone', 'internal'] as const;
export type LifecycleExportError = (typeof LIFECYCLE_EXPORT_ERRORS)[number];

/** Схема упаковки: номер растёт при несовместимом изменении формата. */
export const LIFECYCLE_EXPORT_SCHEMA = 'superapp6.export/1';

/**
 * Пределы выгрузки. Части ≤ 2 ГБ и не больше 5 скачиваний на часть (Google Takeout), ссылка на
 * скачивание живёт 5 минут (presign — токен на предъявителя: недельные ссылки запрещены), готовый
 * архив — 7 дней, новая выгрузка того же субъекта — не чаще раза в сутки.
 */
export const LIFECYCLE_EXPORT_LIMITS = {
  readyDays: 7,
  maxDownloadsPerPart: 5,
  linkTtlSec: 300,
  partMaxBytes: 2 * 1024 ** 3,
  /** Потолок архива целиком (частей не больше 50) — дальше «слишком большой», а не часы работы */
  maxTotalBytes: 100 * 1024 ** 3,
  cooldownHours: 24,
  /** Строк за один запрос сборщика */
  batchRows: 500,
  /** Строк в одном куске JSONL промежуточного хранения */
  chunkRows: 20_000,
  /** Бюджет одного захода джоба сборки (остаток — следующим заходом) */
  budgetMs: 4 * 60_000,
  /** Строка задания живёт месяц после создания (история на странице) */
  rowDays: 30,
} as const;

/**
 * Слова в имени поля, с которыми поле не уходит в архив человека и организации ни при каком
 * владельце: секреты, отпечатки, шифротекст, слепые индексы, подписи. Сравниваются СЛОВА имени
 * (`passwordHash` → password, hash; `notPaid` → not, paid), а не подстрока: подстрока `otp`
 * вырезала бы `notPaid`. Плюс все поля типа Bytes и неподдержанных типов (проверяет сборщик).
 */
const EXPORT_DENY_WORDS: ReadonlySet<string> = new Set([
  'password', 'secret', 'secrets', 'token', 'tokens', 'hash', 'hashed', 'salt', 'cipher', 'ciphertext',
  'wrapped', 'bidx', 'blind', 'signature', 'sig', 'otp', 'pepper', 'enc', 'encrypted', 'nonce', 'iv', 'mac',
  'hmac', 'credential', 'credentials', 'pin', 'kek', 'dek',
]);

/** Поле не уходит в переносимый архив (слово-секрет в имени). */
export function lifecycleExportFieldDenied(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => EXPORT_DENY_WORDS.has(w));
}

export interface LifecycleExportPartDto {
  /** Номер части с 1 */
  index: number;
  bytes: number;
  downloads: number;
  maxDownloads: number;
}

/** Ход сборки: фаза и шаги в ней (политики при сборе, части при упаковке). */
export interface LifecycleExportProgressDto {
  phase: LifecycleExportPhase;
  done: number;
  total: number;
}

export interface LifecycleExportDto {
  id: string;
  subjectType: LifecycleExportSubjectType;
  subjectId: string;
  mode: LifecycleExportMode;
  status: LifecycleExportStatus;
  progress: LifecycleExportProgressDto | null;
  /** Строк в архиве (известно после сборки) */
  rows: number | null;
  bytes: number;
  parts: LifecycleExportPartDto[];
  errorCode: LifecycleExportError | null;
  requestedById: string;
  /** Скачивает только заказавший (архив организации видят владелец и админы, качает заказчик) */
  canDownload: boolean;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string | null;
}

/** Ссылка на скачивание части: живёт `linkTtlSec`, выдаётся на каждое нажатие. */
export interface LifecycleExportLinkDto {
  url: string;
  expiresAt: string;
  /** Скачиваний этой части осталось после выдачи */
  downloadsLeft: number;
}

export const lifecycleExportsQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type LifecycleExportsQuery = z.infer<typeof lifecycleExportsQuerySchema>;

export const lifecycleExportPartParamSchema = z
  .object({ id: z.string().uuid(), part: z.coerce.number().int().min(1).max(999) })
  .strict();
export type LifecycleExportPartParam = z.infer<typeof lifecycleExportPartParamSchema>;

/** Скачивание части по подписанной ссылке (local-драйвер): срок, версия ключа и подпись — в query. */
export const lifecycleExportRawQuerySchema = z
  .object({
    exp: z.coerce.number().int().positive(),
    k: z.string().uuid(),
    sig: z.string().min(16).max(256),
  })
  .strict();
export type LifecycleExportRawQuery = z.infer<typeof lifecycleExportRawQuerySchema>;

/** Сообщение подписи ссылки части (одна правда для выдачи и проверки). */
export function lifecycleExportLinkMessage(exportId: string, part: number, exp: number): string {
  return `lifecycle.export.part:${exportId}:${part}:${exp}`;
}

// ---- Сокет: статус выгрузки сменился (сборка закончилась или упала) ----

/** Событие шины (at-most-once: страница и так перечитывает список) → сокет заказчика. */
export const LIFECYCLE_BUS_EVENTS = { exportUpdated: 'lifecycle.export.updated' } as const;
export const LIFECYCLE_WS_EVENTS = { exportUpdated: 'lifecycle:export.updated' } as const;

export interface LifecycleExportUpdatedBusPayload {
  exportId: string;
  subjectType: LifecycleExportSubjectType;
  subjectId: string;
  status: LifecycleExportStatus;
  /** Кому: заказчик (и для организации — владелец и админы, видящие список) */
  userIds: string[];
}
export type WsLifecycleExportUpdated = Omit<LifecycleExportUpdatedBusPayload, 'userIds'>;

// ---- Манифест ----

export interface LifecycleExportManifestEntry {
  /** Путь в архиве (`data/<политика>.<n>.jsonl`) */
  path: string;
  policyId: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface LifecycleExportManifestFile {
  path: string;
  fileId: string;
  bytes: number;
  sha256: string;
}

/** Политика, чьи строки в архив не вошли, и почему (тариф, нет прав у провайдера). */
export interface LifecycleExportManifestSkip {
  policyId: string;
  reason: 'entitlement' | 'not_applicable';
}

export interface LifecycleExportManifest {
  schema: typeof LIFECYCLE_EXPORT_SCHEMA;
  mode: LifecycleExportMode;
  exportId: string;
  subject: { type: LifecycleExportSubjectType; id: string };
  createdAt: string;
  /** Момент данных источника (restore: время снимка кластера после PITR) */
  snapshotAt: string;
  entries: LifecycleExportManifestEntry[];
  files: LifecycleExportManifestFile[];
  skipped: LifecycleExportManifestSkip[];
  /**
   * Поля под правилами видимости по политикам: в архиве они такие, как их видит заказчик —
   * маска объектом `{ "masked": "…" }`, скрытое — без поля.
   */
  guarded: Record<string, string[]>;
  /** Подпись платформы (только restore): Ed25519 над каноническим манифестом без этого поля */
  signature?: { kid: string; sig: string };
}

/** Канонический текст манифеста для подписи: ключи по алфавиту, без поля подписи. */
export function lifecycleExportManifestPayload(m: Omit<LifecycleExportManifest, 'signature'> & { signature?: unknown }): string {
  const { signature: _omit, ...rest } = m;
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(canon({ type: 'lifecycle.export.manifest', ...rest }));
}

// ---- Восстановление арендатора (Кабинет) ----

/**
 * Извлечение строк организации из кластера на точку времени. `snapshotAt` — точка PITR (при
 * отдельном источнике обязательна: восстановленный кластер своего «когда» не знает); без
 * источника (разработка) — момент извлечения.
 */
export const lifecycleRestoreExtractSchema = z.object({ workspaceId: z.string().uuid(), snapshotAt: z.string().datetime().optional() }).strict();
export type LifecycleRestoreExtractInput = z.infer<typeof lifecycleRestoreExtractSchema>;
export const lifecycleRestoreImportSchema = z.object({ exportId: z.string().uuid() }).strict();
export type LifecycleRestoreImportInput = z.infer<typeof lifecycleRestoreImportSchema>;

/** Итог импорта по таблице: вставлено, пропущено (строка уже есть — конфликт = пропуск), отвергнуто базой. */
export interface LifecycleRestoreTableReport {
  policyId: string;
  inserted: number;
  skipped: number;
  failed: number;
}

export interface LifecycleRestoreReportDto {
  runId: string;
  exportId: string;
  workspaceId: string;
  snapshotAt: string;
  status: 'running' | 'done' | 'failed';
  tables: LifecycleRestoreTableReport[];
  /** Стирания людей после снимка, исполненные заново (реплей журнала стираний) */
  erasuresReplayed: number;
  /** Файлы, чьих байтов нет в хранилище (восстанавливаются версиями S3 — рунбук) */
  missingBlobs: number;
}

/** Строка в Кабинете: архивы восстановления и прогоны импорта. */
export interface LifecycleRestoreArchiveDto {
  exportId: string;
  workspaceId: string;
  status: LifecycleExportStatus;
  rows: number | null;
  snapshotAt: string | null;
  createdAt: string;
  imports: LifecycleRestoreReportDto[];
}

/** Вкладка «Бэкапы и восстановление»: настроен ли источник PITR, архивы и их импорты. */
export interface LifecycleDataRestoresDto {
  sourceConfigured: boolean;
  archives: LifecycleRestoreArchiveDto[];
}
