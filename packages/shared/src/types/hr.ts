// ============================================================
// КЭДО (modules/hr) — DTO провода. Каждый тип стоит на ОБЕИХ сторонах:
// сигнатура читающего метода сервиса API и фетчер веба (правило контрактной
// границы). Date/BigInt сериализуются в строку В СЕРВИСЕ.
// ============================================================

import type {
  CampaignFixMode,
  CampaignMode,
  CampaignStatus,
  CampaignTargetStatus,
  ContractType,
  EmploymentStatus,
  EsutdKind,
  EsutdStatus,
  HrActionKind,
  HrActionSource,
  HrActionStatus,
  PersonalDocKind,
} from '../constants/hr';
import type { DocStatus } from '../constants/org-documents';

/** Человек в КЭДО — только карточкой (Принцип 2), поэтому лайт-профиль */
export interface HrActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

// ---------- Трудовая карточка ----------

export interface EmploymentDto {
  id: string;
  workspaceId: string;
  userId: string;
  /** Работодатель по договору. Совместительство = вторая карточка в другом юрлице. */
  legalEntityId: string;
  /** Снимок имени юрлица на момент договора (переживает переименование) */
  legalEntityName: string | null;
  status: EmploymentStatus;
  hiredAt: string | null; // YYYY-MM-DD
  firedAt: string | null;
  dismissalGround: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  contractType: ContractType;
  contractEndAt: string | null;
  contractExtensionsCount: number;
  probationUntil: string | null;
  legalPositionId: string | null;
  legalPositionName: string | null;
  legalBranchId: string | null;
  legalBranchName: string | null;
  workRate: number | null;
  workSchedule: string | null;
  /** Тиыны строкой (BigInt). Виден Менеджер+ и самому человеку — как и вся карточка */
  salaryAmount: string | null;
  salaryCurrency: string;
  paperMode: boolean;
  personnelNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Расхождение «факт (StaffAssignment) ≠ договор (Employment)» — плашка, не ошибка */
export interface EmploymentMismatchDto {
  mismatch: boolean;
  factPositionName: string | null;
  factBranchName: string | null;
  legalPositionName: string | null;
  legalBranchName: string | null;
}

// ---------- Кадровые действия ----------

export interface HrActionDto {
  id: string;
  workspaceId: string;
  userId: string;
  kind: HrActionKind;
  status: HrActionStatus;
  source: HrActionSource;
  effectiveAt: string; // YYYY-MM-DD
  effectiveTo: string | null;
  params: Record<string, unknown>;
  batchId: string | null;
  employmentId: string | null;
  appliedAt: string | null;
  failReason: string | null;
  createdById: string;
  createdAt: string;
  /** Документы действия (приказ, заявление…) — лёгкие строки */
  documents: HrActionDocLite[];
}

export interface HrActionDocLite {
  id: string;
  title: string;
  number: string | null;
  status: DocStatus;
  templateName: string | null;
}

// ---------- Страница человека ----------

export interface HrMemberCardDto {
  user: HrActorLite & { phone: string | null };
  role: string | null;
  /** Фактические назначения (StaffAssignment) — «как работает» */
  assignments: {
    id: string;
    positionId: string;
    positionName: string;
    departmentName: string | null;
    branchId: string | null;
    branchName: string | null;
    status: string;
  }[];
  /**
   * Юридический план — «как договорились». null = трудовой карточки нет.
   * Совместимость: головное юрлицо, иначе первая из `employments`.
   */
  employment: EmploymentDto | null;
  /** Все трудовые карточки человека в организации (по одной на юрлицо) */
  employments: EmploymentDto[];
  mismatch: EmploymentMismatchDto;
  /** Кадровые действия человека (последние) */
  actions: HrActionDto[];
  /** Документов о человеке в реестре (виджет «Документы · N») */
  documentsCount: number;
  /** Может ли зритель редактировать (Менеджер+) */
  canManage: boolean;
  /** Видна ли трудовая карточка (Менеджер+ или сам человек) */
  canSeeEmployment: boolean;
}

/** Ростер: лёгкая кадровая сводка для фильтров «нет договора / расхождение» (Менеджер+) */
export interface HrRosterOverviewDto {
  /** userId → сводка; отсутствие ключа = трудовой карточки нет */
  byUser: Record<string, { status: EmploymentStatus; mismatch: boolean }>;
}

// ---------- ЕСУТД ----------

export interface EsutdSubmissionDto {
  id: string;
  workspaceId: string;
  userId: string;
  kind: EsutdKind;
  hrActionId: string | null;
  employmentId: string | null;
  dueAt: string; // YYYY-MM-DD
  status: EsutdStatus;
  submittedAt: string | null;
  submittedById: string | null;
  externalNumber: string | null;
  correctionUntil: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Рабочих дней до срока; отрицательное = просрочено. null — календарь не покрывает дату */
  workDaysLeft: number | null;
}

// ---------- Сводный экран «Кадровые сроки» ----------

export interface HrDeadlineItemDto {
  key: string; // уникален в списке
  kind: 'esutd' | 'delivery' | 'settlement' | 'probation' | 'contract_end' | 'campaign';
  userId: string | null;
  title: string;
  subtitle: string;
  dueAt: string | null; // YYYY-MM-DD
  /** Рабочих дней до срока (по производственному календарю); null — не считается */
  workDaysLeft: number | null;
  overdue: boolean;
  href: string | null;
}

export interface HrDeadlinesDto {
  esutd: HrDeadlineItemDto[];
  deliveries: HrDeadlineItemDto[];
  settlements: HrDeadlineItemDto[];
  probations: HrDeadlineItemDto[];
  contractEnds: HrDeadlineItemDto[];
  campaigns: HrDeadlineItemDto[];
  /** Всего «горит» (бейдж пункта «Сотрудники» и плитки Главной) */
  total: number;
  actors: Record<string, HrActorLite>;
}

// ---------- Массовые действия ----------

export interface HrActionBatchDto {
  id: string;
  workspaceId: string;
  kind: HrActionKind;
  params: Record<string, unknown>;
  total: number;
  status: 'running' | 'done' | 'cancelled';
  createdById: string;
  createdAt: string;
  /** Прогресс по статусам действий пачки */
  progress: Record<HrActionStatus, number>;
}

// ---------- Кампании ознакомления ----------

export interface DocCampaignDto {
  id: string;
  workspaceId: string;
  title: string;
  orgDocumentId: string;
  mode: CampaignMode;
  fixMode: CampaignFixMode;
  status: CampaignStatus;
  dueAt: string | null;
  createdById: string;
  createdAt: string;
  completedAt: string | null;
  /** Счётчики адресатов по статусам */
  counts: Record<CampaignTargetStatus, number>;
  total: number;
}

export interface DocCampaignTargetDto {
  id: string;
  userId: string;
  status: CampaignTargetStatus;
  acknowledgedAt: string | null;
  remindedAt: string | null;
  /** Вечный след: sha256 замороженного предмета на момент фиксации (click и sms) */
  subjectSha256: string | null;
}

export interface DocCampaignDetailDto extends DocCampaignDto {
  targets: DocCampaignTargetDto[];
  actors: Record<string, HrActorLite>;
}

/** Задание кампании глазами адресата (стопка «Ждут решения» + отметка) */
/**
 * Моё незакрытое задание кампании по конкретному документу (баннер «Ознакомьтесь»
 * на его карточке). Форма — РОВНО та, что отдаёт сервер: тип, объявленный
 * «на будущее» и не импортированный ни одной стороной, разъезжается молча
 * (правило контрактной границы), а этот успел объявить четыре поля, которых
 * в ответе нет вовсе.
 */
export interface MyCampaignTaskDto {
  campaignId: string;
  fixMode: CampaignFixMode;
  /** sms-режим: заявка подписи, куда ведёт кнопка «Подтвердить кодом» */
  signRequestId: string | null;
}

// ---------- Личный архив «Мои документы» ----------

export interface PersonalDocRecordDto {
  id: string;
  workspaceId: string;
  workspaceName: string;
  orgDocumentId: string | null;
  /** Организация ещё жива — ссылки внутрь неё работают */
  workspaceAlive: boolean;
  title: string;
  number: string | null;
  docTypeName: string | null;
  kind: PersonalDocKind;
  reachedAt: string;
  /** Подписанная ссылка на файл (штампованная копия, если есть) */
  downloadUrl: string | null;
  /** Публичная проверка подписи (если документ подписывался) */
  checkUrl: string | null;
}

// ---------- Библиотека кадровых бланков ----------

export interface HrLibraryItemDto {
  key: string;
  title: string;
  description: string;
  category: 'hr' | 'general';
  signatureLevel: 'none' | 'pep' | 'ecp';
  version: number;
  /** Установлен ли в эту организацию; версия установки для «Обновить» */
  installed: boolean;
  installedVersion: number | null;
  templateId: string | null;
  updateAvailable: boolean;
}
