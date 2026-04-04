export type WorkspaceType = 'personal' | 'business';
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member' | 'guest';

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
  role: WorkspaceRole;
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
  role: WorkspaceRole;
  department?: string;
  position?: string;
}

// Permissions per workspace role
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, string[]> = {
  owner: ['*'],
  admin: [
    'workspace.settings', 'workspace.members.manage',
    'tasks.create', 'tasks.assign', 'tasks.delete',
    'coins.manage', 'shop.manage',
    'checklists.manage', 'courses.manage', 'tests.manage',
  ],
  manager: [
    'tasks.create', 'tasks.assign',
    'coins.give',
    'checklists.manage',
  ],
  member: [
    'tasks.view', 'tasks.update_own',
    'coins.view', 'shop.view',
    'checklists.complete',
    'courses.view', 'tests.take',
  ],
  guest: [
    'tasks.view_assigned',
  ],
};
