// ============================================================
// Орг. структура (B2B): DTO вертикали, канваса, заместителей, областных прав.
// Одна форма провода = один тип здесь, на ОБЕИХ сторонах (contract_boundary).
// ============================================================

import type { WorkspaceRole } from '../constants/roles';
import type { OrgDeputyKind, OrgManagerReason } from '../constants/org';
import type { StaffAssignmentStatus } from './staff';

/** Лайт-профиль человека для PersonChip/PersonAvatar (батч-обогащение ответа) */
export interface OrgPersonLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/** Область правки структуры: вся · свои ветки/объекты · ничего */
export interface OrgScopeDto {
  kind: 'all' | 'scoped' | 'none';
  /** Отделы, которые человек вправе править (с потомками — записаны проекцией) */
  departmentIds: string[];
  /** Объекты, назначениями которых человек вправе управлять */
  branchIds: string[];
  role: WorkspaceRole | null;
}

export interface OrgHolderDto {
  userId: string;
  assignmentId: string;
  branchId: string;
  isPrimary: boolean;
  status: StaffAssignmentStatus;
}

export interface OrgDeputyDto {
  id: string;
  positionId: string;
  positionName: string;
  branchId: string | null;
  branchName: string | null;
  deputyPositionId: string | null;
  deputyPositionName: string | null;
  deputyUserId: string | null;
  /** YYYY-MM-DD или null */
  startsOn: string | null;
  endsOn: string | null;
  note: string | null;
  kind: OrgDeputyKind;
  /** Датированное замещение действует сегодня (запасной — всегда «наготове») */
  activeToday: boolean;
  createdById: string;
  createdAt: string;
}

export interface OrgChartPositionDto {
  id: string;
  name: string;
  glyph: string | null;
  departmentId: string | null;
  reportsToPositionId: string | null;
  /**
   * Разрешённый руководитель В ЭТОМ ВИДЕ (с учётом фильтра объекта): переопределение →
   * голова отдела (вверх по дереву) → голова объекта → null (корень). Считает сервер —
   * клиент раскладку по нему строит, а не выводит сам.
   */
  superiorPositionId: string | null;
  holders: OrgHolderDto[];
  /** Должность без держателей (в этом объекте при фильтре) — вакансия */
  vacant: boolean;
  headsDepartmentIds: string[];
  headsBranchIds: string[];
  sortOrder: number;
}

export interface OrgChartDepartmentDto {
  id: string;
  name: string;
  parentId: string | null;
  headPositionId: string | null;
  /** Глубина в дереве (0 = корень) — рамки на канвасе рисуются до 2 уровней */
  depth: number;
  sortOrder: number;
}

export interface OrgChartBranchDto {
  id: string;
  name: string;
  isDefault: boolean;
  headPositionId: string | null;
}

export interface OrgChartEdgeDto {
  from: string;
  to: string;
  /** Сплошная (подчинение) / пунктир (замещение) */
  kind: 'reports' | 'deputy';
  /** У замещения — период (для подписи на пунктире) */
  startsOn?: string | null;
  endsOn?: string | null;
}

/** Цельный граф организации (потолок ORG_LIMITS.maxChartPositions — честный 409) */
export interface OrgChartDto {
  workspaceId: string;
  /** Фильтр «Объект» (null = типовая схема всей организации) */
  branchId: string | null;
  positions: OrgChartPositionDto[];
  departments: OrgChartDepartmentDto[];
  branches: OrgChartBranchDto[];
  edges: OrgChartEdgeDto[];
  /** Должности без разрешимого руководителя (второй корень — сигнал интерфейсу) */
  roots: string[];
  /** Люди для аватаров/чипов — батч */
  people: Record<string, OrgPersonLite>;
  ownerUserId: string;
  /** Владелец держит хоть одну должность (иначе — «вне схемы», законно) */
  ownerInChart: boolean;
  /** Должности зрителя (для «моей ветки» по умолчанию) */
  myPositionIds: string[];
  scope: OrgScopeDto;
  /** Схема считается собранной: есть хоть одна голова или переопределение */
  assembled: boolean;
  /** Кандидат в вершину для мастера — директор из реквизитов организации */
  suggestedTopUserId: string | null;
  deputies: OrgDeputyDto[];
  counts: { positions: number; departments: number; branches: number; people: number; unassigned: number; vacancies: number };
}

/** «Вне структуры»: люди без назначений, вакансии, несколько корней */
export interface OrgUnassignedDto {
  people: Array<{ userId: string; role: WorkspaceRole }>;
  vacancies: Array<{ positionId: string; name: string }>;
  roots: Array<{ positionId: string; name: string }>;
  persons: Record<string, OrgPersonLite>;
}

export interface OrgManagerDto {
  positionId: string | null;
  positionName: string | null;
  userIds: string[];
  viaDeputy: boolean;
  /** До какой даты действует датированное замещение (если viaDeputy) */
  deputyUntil: string | null;
  branchId: string | null;
  reason: OrgManagerReason;
}

export interface OrgLineAssignmentDto {
  assignmentId: string;
  positionId: string;
  positionName: string;
  departmentId: string | null;
  departmentName: string | null;
  branchId: string;
  branchName: string;
  isPrimary: boolean;
  status: StaffAssignmentStatus;
}

export interface OrgLineChainStepDto {
  positionId: string;
  positionName: string;
  userIds: string[];
  viaDeputy: boolean;
}

/** «Место в структуре» человека: должности, руководитель, команда, цепочка вверх */
export interface OrgLineDto {
  userId: string;
  assignments: OrgLineAssignmentDto[];
  /** По какому назначению посчитано (основное, либо запрошенное) */
  resolvedAssignmentId: string | null;
  manager: OrgManagerDto;
  chain: OrgLineChainStepDto[];
  /** Подчинённые (точная инверсия managerOf по всем назначениям) */
  team: { userIds: string[]; count: number };
  /** Руководители по ПРОЧИМ назначениям («также: …») */
  others: Array<{ assignmentId: string; manager: OrgManagerDto }>;
  people: Record<string, OrgPersonLite>;
}

/** Ответ мастера «Соберём структуру» */
export interface OrgSetupResultDto {
  topPositionId: string | null;
  departmentsUpdated: number;
  branchesUpdated: number;
}
