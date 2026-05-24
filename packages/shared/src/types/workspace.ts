// ============================================================
// Workspaces (B2B organizations)
// ============================================================
// A Workspace is ALWAYS a business/organization (B2B tenant). A person's personal
// life is the social graph (workspaceId = null), NOT a workspace.
// Role & permissions live in UserRole (context="workspace", tenantId=workspaceId) —
// the single source of truth. WorkspaceMember holds only HR metadata (department/position).
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

export interface Workspace {
  id: string;
  name: string;
  logo: string | null;
  ownerId: string;
  membersCount: number;
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
  department: string | null;
  position: string | null;
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
  role: WorkspaceRoleT;
  position: string | null;
  department: string | null;
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

export interface InviteMemberRequest {
  phone: string;
  role: WorkspaceRoleT;
  position?: string;
  department?: string;
  message?: string;
}

export interface UpdateMemberRequest {
  role?: WorkspaceRoleT;
  position?: string | null;
  department?: string | null;
}

export interface TransferOwnershipRequest {
  toUserId: string;
}
