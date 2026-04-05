export type WorkspaceType = 'personal' | 'business';

// WorkspaceRole определён в constants/roles.ts — реэкспортируем для обратной совместимости
export { type WorkspaceRole } from '../constants/roles';

export interface Workspace {
  id: string;
  name: string;
  type: WorkspaceType;
  logo: string | null;
  ownerId: string;
  membersCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  userName: string;
  userAvatar: string | null;
  role: import('../constants/roles').WorkspaceRole;
  department: string | null;
  position: string | null;
  joinedAt: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  type: WorkspaceType;
  logo?: string;
}

export interface InviteMemberRequest {
  phone: string;
  role: import('../constants/roles').WorkspaceRole;
  department?: string;
  position?: string;
}
