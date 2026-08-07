// ============================================================
// Staff (B2B «Сотрудники»): справочники организации + назначения
// ============================================================
// Должность/Отдел/Филиал — первоклассные сущности-справочники воркспейса.
// Назначение (StaffAssignment) = человек × должность × (опц.) филиал, со статусом
// обучения под будущее Додзё. Членство в отделе — ПРОИЗВОДНОЕ от должности
// (Position.departmentId), как позиция штатного расписания 1С.
// Роль прав (Стажёр/Сотрудник/…) живёт отдельно в UserRole — см. constants/roles.ts.

import type { WorkspaceRole } from '../constants/roles';

/** Статус обучения по конкретной должности (Додзё будет переключать training→certified). */
export type StaffAssignmentStatus = 'training' | 'certified';

export interface StaffDepartment {
  id: string;
  workspaceId: string;
  name: string;
  /** Дерево в данных (отдел внутри отдела); UI пока показывает плоско с родителем. */
  parentId: string | null;
  sortOrder: number;
  /** Сколько людей в отделе (производное: держатели должностей отдела). */
  membersCount?: number;
  /** Сколько должностей привязано к отделу. */
  positionsCount?: number;
  createdAt: string;
}

export interface StaffPosition {
  id: string;
  workspaceId: string;
  name: string;
  /** Отдел, которому принадлежит должность (опционально). */
  departmentId: string | null;
  departmentName?: string | null;
  description: string | null;
  sortOrder: number;
  /** Сколько людей держат эту должность. */
  holdersCount?: number;
  createdAt: string;
}

export interface StaffBranch {
  id: string;
  workspaceId: string;
  name: string;
  address: string | null;
  note: string | null;
  sortOrder: number;
  /** Сколько людей работают в филиале (по назначениям). */
  membersCount?: number;
  createdAt: string;
}

/** Назначение должности человеку (с филиалом или без). Несколько на человека — норма. */
export interface StaffAssignment {
  id: string;
  workspaceId: string;
  userId: string;
  positionId: string;
  positionName: string;
  /** Производное от должности (Position.departmentId) — для отображения/фильтров. */
  departmentId: string | null;
  departmentName: string | null;
  branchId: string | null;
  branchName: string | null;
  status: StaffAssignmentStatus;
  assignedBy: string | null;
  createdAt: string;
}

/** Справочники одним ответом — для вкладок и форм. */
export interface StaffDirectory {
  departments: StaffDepartment[];
  positions: StaffPosition[];
  branches: StaffBranch[];
}

// ---------- Requests ----------
