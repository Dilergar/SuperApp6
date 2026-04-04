// System-level permissions (not workspace-specific)
export const SYSTEM_PERMISSIONS = {
  // User management
  'users.view': 'Просмотр пользователей',
  'users.manage': 'Управление пользователями',

  // Workspaces
  'workspaces.create': 'Создание рабочих пространств',
  'workspaces.manage_all': 'Управление всеми пространствами',

  // Subscriptions
  'subscriptions.manage': 'Управление подписками',

  // Admin
  'admin.access': 'Доступ к админ-панели',
  'admin.full': 'Полный доступ администратора',
} as const;

export type SystemPermission = keyof typeof SYSTEM_PERMISSIONS;

// System roles
export const SYSTEM_ROLES = {
  user: {
    name: 'Пользователь',
    permissions: ['workspaces.create'] as SystemPermission[],
  },
  moderator: {
    name: 'Модератор',
    permissions: ['users.view', 'workspaces.create'] as SystemPermission[],
  },
  admin: {
    name: 'Администратор',
    permissions: Object.keys(SYSTEM_PERMISSIONS) as SystemPermission[],
  },
} as const;

export type SystemRole = keyof typeof SYSTEM_ROLES;
