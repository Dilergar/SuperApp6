import { SetMetadata } from '@nestjs/common';

export interface RequiredRole {
  role: string;
  context: string;
  // tenantId берётся из параметров запроса (req.params.workspaceId и т.д.)
  tenantParam?: string; // имя параметра в URL, например 'workspaceId'
}

export const ROLES_KEY = 'roles';

/**
 * @Roles({ role: 'admin', context: 'system' })
 * @Roles({ role: 'staff', context: 'workspace', tenantParam: 'workspaceId' })
 * @Roles({ role: 'owner', context: 'circle', tenantParam: 'circleId' })
 */
export const Roles = (...roles: RequiredRole[]) =>
  SetMetadata(ROLES_KEY, roles);
