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
  /** Дерево в данных (отдел внутри отдела). */
  parentId: string | null;
  sortOrder: number;
  /** Руководящая должность отдела (может лежать ВНЕ отдела и вести несколько отделов). */
  headPositionId: string | null;
  headPositionName?: string | null;
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
  /** Точечное переопределение подчинения — сильнее дерева отделов и головы объекта. */
  reportsToPositionId: string | null;
  /** Значок-данные для <Glyph/> (ключ реестра иконок или эмодзи). */
  glyph: string | null;
  /** Сколько людей держат эту должность. */
  holdersCount?: number;
  createdAt: string;
}

/** Объект организации (в UI пока «Филиал»); у организации всегда есть основной. */
export interface StaffBranch {
  id: string;
  workspaceId: string;
  name: string;
  address: string | null;
  note: string | null;
  sortOrder: number;
  /** Основной объект: назначение без объекта попадает сюда; удалить нельзя. */
  isDefault: boolean;
  /** Руководящая должность объекта («Управляющий точкой»). */
  headPositionId: string | null;
  headPositionName?: string | null;
  /** Сколько людей работают в объекте (по назначениям). */
  membersCount?: number;
  createdAt: string;
}

/** Назначение должности человеку — ВСЕГДА в объекте. Несколько на человека — норма. */
export interface StaffAssignment {
  id: string;
  workspaceId: string;
  userId: string;
  positionId: string;
  positionName: string;
  /** Производное от должности (Position.departmentId) — для отображения/фильтров. */
  departmentId: string | null;
  departmentName: string | null;
  branchId: string;
  branchName: string;
  /** Основное место человека (ровно одно на организацию). */
  isPrimary: boolean;
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
