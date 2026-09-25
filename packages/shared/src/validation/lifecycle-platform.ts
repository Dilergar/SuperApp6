import { z } from 'zod';
import type { LifecycleDuration } from '../lifecycle/types';
import type { LifecycleErasureStatus, LifecycleHoldDto } from './lifecycle';

// ============================================================
// Кабинет платформы: дашборд «Данные» (core/lifecycle Э5) — `/platform/data`
// ============================================================
// Шесть вкладок: обзор («всё ли хорошо» за 5 секунд), хранилище, сроки хранения, стирания и
// заморозки, бэкапы и восстановление, канарейка. Право `data.read`. Данные — агрегаты
// (`pg_stat_*`, таблицы движка, суточные снимки): ни строк пользователей, ни ПДн.

/** Светофор плитки: цвет — только тон чипа, красный лишь у критического. */
export const LIFECYCLE_HEALTH_LEVELS = ['ok', 'warning', 'critical', 'unknown'] as const;
export type LifecycleHealthLevel = (typeof LIFECYCLE_HEALTH_LEVELS)[number];

/** Виды отчётов бэкапа и учений (строка `lifecycle_backup_runs.kind`). */
export const LIFECYCLE_BACKUP_KINDS = ['full', 'incr', 'diff', 'verify', 'wal', 'restore_drill', 'pitr_drill', 'dr_drill', 's3_replication'] as const;
export type LifecycleBackupKind = (typeof LIFECYCLE_BACKUP_KINDS)[number];
export const LIFECYCLE_BACKUP_STATUSES = ['ok', 'failed'] as const;
export type LifecycleBackupStatus = (typeof LIFECYCLE_BACKUP_STATUSES)[number];

/** Окно PITR и хранения бэкапов (plan §9: 35 дней, оба репозитория). */
export const LIFECYCLE_BACKUP_WINDOW_DAYS = 35;

/** Проверки ночного авто-restore (строка отчёта `restore_drill`). */
export const LIFECYCLE_RESTORE_CHECKS = ['row_counts', 'ledger_sum', 'audit_merkle', 'erasure_replay'] as const;
export type LifecycleRestoreCheck = (typeof LIFECYCLE_RESTORE_CHECKS)[number];

/**
 * Отчёт бэкапа или учения — присылает скрипт pgBackRest / restore-drill (`POST
 * /lifecycle/ops/backups/report`, Bearer `LIFECYCLE_OPS_TOKEN` + подпись тела). Идемпотентен
 * по (`kind`, `repo`, `externalId`): повтор не заводит вторую строку.
 */
export const lifecycleBackupReportSchema = z
  .object({
    kind: z.enum(LIFECYCLE_BACKUP_KINDS),
    repo: z.string().trim().min(1).max(32).regex(/^[a-z0-9_-]+$/i),
    status: z.enum(LIFECYCLE_BACKUP_STATUSES),
    externalId: z.string().trim().min(1).max(128),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable().optional(),
    bytes: z.number().int().min(0).nullable().optional(),
    /** Детали — коды и числа: проверки restore, RTO, лаг репликации S3, покрытие WAL */
    details: z
      .object({
        checks: z.record(z.enum(LIFECYCLE_RESTORE_CHECKS), z.boolean()).optional(),
        rtoSeconds: z.number().int().min(0).optional(),
        replicationLagSeconds: z.number().min(0).optional(),
        walFrom: z.string().datetime().optional(),
        walTo: z.string().datetime().optional(),
        errorCode: z.string().trim().max(64).regex(/^[a-z0-9_.-]+$/i).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LifecycleBackupReportInput = z.infer<typeof lifecycleBackupReportSchema>;

export interface LifecycleBackupRunDto {
  id: string;
  kind: LifecycleBackupKind;
  repo: string;
  status: LifecycleBackupStatus;
  startedAt: string;
  finishedAt: string | null;
  bytes: number | null;
  details: LifecycleBackupReportInput['details'] | null;
  reportedAt: string;
}

// ---- Обзор ----

export interface LifecycleDataOverviewDto {
  checkedAt: string;
  database: {
    level: LifecycleHealthLevel;
    xidAge: number;
    /** Порог «страница» возраста XID (1 млрд): tick-прогресс к нему */
    xidLimit: number;
    dbBytes: number;
    connections: number;
    maxConnections: number;
    replicas: number;
    maxReplayLagSeconds: number;
    lockWaiters: number;
    lockManagerWaits: number;
    invalidIndexes: number;
  };
  backups: {
    level: LifecycleHealthLevel;
    lastSuccessAt: string | null;
    /** Суток окна PITR с успешным бэкапом (из `windowDays`) */
    coveredDays: number;
    windowDays: number;
    repos: Array<{ repo: string; lastSuccessAt: string | null }>;
    lastDrill: { at: string; ok: boolean } | null;
  };
  partitions: {
    level: LifecycleHealthLevel;
    parents: number;
    /** Наименьший запас партиций вперёд среди родителей (null — партиций нет) */
    minAhead: number | null;
    detachPending: number;
  };
  retention: {
    level: LifecycleHealthLevel;
    /** Политик, где старейшая строка старше срока больше чем на сутки (по ночному снимку) */
    lagging: number;
    maxLagDays: number;
    nextRunAt: string;
  };
  erasure: {
    level: LifecycleHealthLevel;
    queued: number;
    stuck: number;
    held: number;
    /** Среднее от заявки до «стёрто из рабочих систем» за 90 дней (сутки; null — не было) */
    avgDaysToHotPurge: number | null;
  };
  canary: {
    level: LifecycleHealthLevel;
    lastRunAt: string | null;
    lastOk: boolean | null;
    findings: number;
    unseeded: number;
  };
  /** Рост хранилища по классам данных, 90 дней (сутки × класс → байты) */
  growth: Array<{ day: string; dataClass: string; bytes: number }>;
  /** Удалено и стёрто строк в сутки, 30 дней */
  deletedPerDay: Array<{ day: string; rows: number }>;
  /** «Нужно внимание»: код, серьёзность и числа для текста */
  attention: Array<{ code: LifecycleAttentionCode; severity: 'critical' | 'warning'; params: Record<string, string | number> }>;
}

export const LIFECYCLE_ATTENTION_CODES = [
  'backup_never',
  'backup_missing',
  'backup_failed',
  'drill_failed',
  'partition_runway_low',
  'detach_pending',
  'retention_lag',
  'erasure_stuck',
  'erasure_held',
  'canary_failed',
  'canary_unseeded',
  'xid_age_high',
  'replica_lag',
  'invalid_indexes',
] as const;
export type LifecycleAttentionCode = (typeof LIFECYCLE_ATTENTION_CODES)[number];

// ---- Хранилище ----

export interface LifecycleDataStorageDto {
  tables: Array<{
    table: string;
    policyId: string | null;
    dataClass: string | null;
    bytes: number;
    /** Рост за 7 суток по снимкам (null — снимков ещё нет) */
    growth7dBytes: number | null;
    liveRows: number;
    deadRows: number;
    bloatPct: number;
    lastAutovacuumAt: string | null;
    invalidIndexes: number;
  }>;
  connections: { total: number; active: number; idleInTransaction: number; max: number };
  locks: { waiters: number; lockManager: number };
}

// ---- Сроки хранения ----

export interface LifecycleDataRetentionRowDto {
  policyId: string;
  dataClass: string;
  owner: string;
  enforcement: string;
  retention: { floorDays: LifecycleDuration | null; defaultDays: LifecycleDuration; ceilingDays: LifecycleDuration | null };
  tenantConfigurable: boolean;
  /** Раннер ведёт политику (есть режим прогона) — сухой прогон и пауза имеют смысл */
  runnable: boolean;
  /** Срок политики меняется командой (построчное удаление без своего шага владельца) */
  overridable: boolean;
  /** Пауза или срок, заданные командой Кабинета */
  override: { paused: boolean; days: number | null; reason: string; changedAt: string } | null;
  /** Строк и старейшая строка по ночному снимку */
  rows: number | null;
  oldestAt: string | null;
  /** Отставание от срока в сутках (null — срок вечен или данных нет) */
  lagDays: number | null;
  lastRun: { id: string; status: string; dryRun: boolean; rows: number; expectedRows: number | null; stoppedReason: string | null; startedAt: string; finishedAt: string | null } | null;
}

export interface LifecycleDataRetentionDto {
  rows: LifecycleDataRetentionRowDto[];
  nextRunAt: string;
  snapshotDay: string | null;
}

// ---- Стирания и заморозки ----

export interface LifecycleDataErasureRowDto {
  id: string;
  subjectType: 'user' | 'workspace';
  /** Первые символы псевдонима (без id субъекта) */
  pseudonym: string;
  status: LifecycleErasureStatus;
  requestedAt: string;
  effectiveAt: string;
  hiddenAt: string | null;
  hotPurgedAt: string | null;
  keysDestroyedAt: string | null;
  backupsClearAt: string | null;
  completedAt: string | null;
  lastProgressAt: string;
  attempts: number;
  errorCode: string | null;
  stuck: boolean;
}

export interface LifecycleDataErasureDto {
  queue: LifecycleDataErasureRowDto[];
  completed90d: number;
  platformHolds: LifecycleHoldDto[];
  organizationHolds: number;
}

// ---- Бэкапы ----

export interface LifecycleDataBackupsDto {
  windowDays: number;
  /** Сутки окна: успешный full/incr/diff был, WAL покрыт */
  coverage: Array<{ day: string; backup: boolean; wal: boolean }>;
  runs: LifecycleBackupRunDto[];
  drills: LifecycleBackupRunDto[];
  replication: { lagSeconds: number | null; at: string | null };
  /** Отчёты ещё ни разу не приходили (скрипты не подключены) */
  empty: boolean;
}

// ---- Канарейка ----

export interface LifecycleDataCanaryRunDto {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stores: number;
  findings: number;
  unseeded: number;
  durationMs: number | null;
  /** Где нашёлся след: хранилище и вид находки (коды) */
  details: Array<{ store: string; kind: string }>;
}

export interface LifecycleDataCanaryDto {
  runs: LifecycleDataCanaryRunDto[];
}

// ---- Команды Кабинета ----

export const lifecycleRetentionDryRunSchema = z.object({ policyId: z.string().min(1).max(64) }).strict();
export type LifecycleRetentionDryRunInput = z.infer<typeof lifecycleRetentionDryRunSchema>;

export const lifecycleRetentionPauseSchema = z.object({ policyId: z.string().min(1).max(64), paused: z.boolean() }).strict();
export type LifecycleRetentionPauseInput = z.infer<typeof lifecycleRetentionPauseSchema>;

/** Срок политики командой: `days = null` — снять переопределение (действует реестр). */
export const lifecycleRetentionOverrideSchema = z
  .object({ policyId: z.string().min(1).max(64), days: z.number().int().min(1).max(36_500).nullable() })
  .strict();
export type LifecycleRetentionOverrideInput = z.infer<typeof lifecycleRetentionOverrideSchema>;

export const lifecycleErasureRetrySchema = z.object({ requestId: z.string().uuid() }).strict();
export type LifecycleErasureRetryInput = z.infer<typeof lifecycleErasureRetrySchema>;

export const lifecycleIndexesReportSchema = z.object({}).strict();

/** Отчёт неиспользуемых индексов (результат команды, в журнал не пишется). */
export interface LifecycleUnusedIndexDto {
  table: string;
  index: string;
  bytes: number;
  scans: number;
}

// ---- Панели карточки 360 ----

export interface PlatformUserLifecyclePanelDto {
  deletionScheduledAt: string | null;
  erasure: Array<{ id: string; status: LifecycleErasureStatus; requestedAt: string; effectiveAt: string; completedAt: string | null }>;
  /** Действующие заморозки, где человек — хранитель */
  custodianHolds: number;
}

export interface PlatformWorkspaceLifecyclePanelDto {
  archivedAt: string | null;
  purgeAt: string | null;
  settings: Array<{ dataClass: string; days: LifecycleDuration; pending: { days: LifecycleDuration; effectiveAt: string } | null }>;
  activeHolds: number;
  erasure: { id: string; status: LifecycleErasureStatus; effectiveAt: string } | null;
}
