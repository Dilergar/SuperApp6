// ============================================================
// Workspaces (B2B organizations)
// ============================================================
// A Workspace is ALWAYS a business/organization (B2B tenant). A person's personal
// life is the social graph (workspaceId = null), NOT a workspace.
// Role & permissions live in UserRole (context="workspace", tenantId=workspaceId) —
// the single source of truth. Должности/отделы/филиалы — сущности StaffModule
// (см. types/staff.ts); назначения присоединяются к member-DTO сервисом.
// These interfaces are API DTOs (assembled views), not raw DB rows: `role` on a member
// is read from UserRole, and user name/avatar are joined in by the service.

// WorkspaceRole is defined in constants/roles.ts — re-export for convenience.
export { type WorkspaceRole } from '../constants/roles';

type WorkspaceRoleT = import('../constants/roles').WorkspaceRole;

export type WorkspaceInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

// Default visibility of the company card's OPTIONAL fields to members (employees).
// Always-visible regardless: name, logo. Owner/admin always see everything (for editing).
export interface WorkspaceCardVisibility {
  description: boolean;
  industry: boolean;
  city: boolean;
  website: boolean;
  contactEmail: boolean;
  contactPhone: boolean;
  membersCount: boolean;
  extras?: Record<string, boolean>;
}

export interface Workspace {
  id: string;
  name: string;
  logo: string | null;
  // Company profile (Анкета). For non-manager viewers, fields hidden by cardVisibility
  // are returned as null. owner/admin always get the real values.
  description: string | null;
  industry: string | null;
  city: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Default field-visibility to members. Present ONLY for owner/admin (editing). */
  cardVisibility?: WorkspaceCardVisibility;
  ownerId: string;
  membersCount: number;
  /** Active (non-cancelled) task count — present in the single-workspace view. */
  tasksCount?: number;
  isActive: boolean;
  /** The viewing user's role in this workspace (from UserRole). Present in "my workspaces" lists. */
  myRole?: WorkspaceRoleT;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  /** WorkspaceMember row id (the HR card). */
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
  /** Assembled from UserRole (single source of truth) — NOT stored on WorkspaceMember. */
  role: WorkspaceRoleT;
  /** Назначения должностей (StaffModule), присоединяются сервисом. */
  assignments: import('./staff').StaffAssignment[];
  /**
   * Карточка человека для КОЛЛЕГ — те же поля, что видит окружение в b2c,
   * но скрытые по «Видимости в Компаниях» владельца поля приходят null.
   * Всегда видны: имя, фамилия, телефон (+ должности в assignments).
   */
  card: import('./contact').ContactUserCard;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceLogo: string | null;
  invitedBy: string;
  invitedByName: string;
  toUserId: string | null;
  toPhone: string;
  /** Всегда trainee для новых приглашений (выбора роли больше нет). */
  role: WorkspaceRoleT;
  /** Опциональная должность + филиалы «с порога»: примет — назначения создадутся сами
   *  (по одному на филиал; сотрудник может обслуживать несколько). */
  positionId: string | null;
  positionName: string | null;
  branchIds: string[];
  branchNames: string[];
  message: string | null;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  logo?: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  logo?: string | null;
}

// Найм всегда в Стажёра — роли в запросе НЕТ. Должность + филиалы опциональны
// (несколько филиалов: сотрудник может обслуживать сразу несколько).
export interface InviteMemberRequest {
  phone: string;
  positionId?: string;
  branchIds?: string[];
  message?: string;
}

// Смена роли: admin → manager/staff/trainee; admin назначает только владелец.
// contractor вручную не назначается. Должности меняются назначениями (StaffModule).
export interface UpdateMemberRequest {
  role: WorkspaceRoleT;
}

export interface TransferOwnershipRequest {
  toUserId: string;
}
