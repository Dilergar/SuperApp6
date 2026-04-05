// ============================================================
// Universal Identity: роли привязаны к контексту
// Один user может быть admin в системе, staff в workspace A, guest в workspace B
// ============================================================

// Контексты, в которых могут существовать роли
export const ROLE_CONTEXTS = {
  system: 'system',       // Глобальные роли платформы
  workspace: 'workspace', // Роли внутри рабочего пространства
  circle: 'circle',       // Роли внутри окружения
} as const;

export type RoleContext = (typeof ROLE_CONTEXTS)[keyof typeof ROLE_CONTEXTS];

// Системные роли (context = "system", tenantId = null)
export const SYSTEM_ROLES = {
  user: {
    name: 'Пользователь',
    description: 'Обычный пользователь платформы',
    permissions: ['workspaces.create', 'circles.create'] as SystemPermission[],
  },
  moderator: {
    name: 'Модератор',
    description: 'Модератор контента',
    permissions: ['users.view', 'workspaces.create', 'circles.create'] as SystemPermission[],
  },
  admin: {
    name: 'Администратор',
    description: 'Полный доступ к платформе',
    permissions: Object.keys({
      'users.view': true,
      'users.manage': true,
      'workspaces.create': true,
      'workspaces.manage_all': true,
      'subscriptions.manage': true,
      'admin.access': true,
      'admin.full': true,
    }) as SystemPermission[],
  },
} as const;

export type SystemRole = keyof typeof SYSTEM_ROLES;

// Роли в workspace (context = "workspace", tenantId = workspace_id)
export const WORKSPACE_ROLES = {
  owner: {
    name: 'Владелец',
    description: 'Создатель рабочего пространства',
    permissions: ['workspace.manage', 'workspace.members', 'workspace.tasks', 'workspace.delete'] as WorkspacePermission[],
  },
  admin: {
    name: 'Администратор',
    description: 'Управляет пространством',
    permissions: ['workspace.manage', 'workspace.members', 'workspace.tasks'] as WorkspacePermission[],
  },
  manager: {
    name: 'Менеджер',
    description: 'Управляет задачами и сотрудниками',
    permissions: ['workspace.members.view', 'workspace.tasks'] as WorkspacePermission[],
  },
  staff: {
    name: 'Сотрудник',
    description: 'Выполняет задачи',
    permissions: ['workspace.tasks.own', 'workspace.members.view'] as WorkspacePermission[],
  },
  guest: {
    name: 'Гость',
    description: 'Ограниченный доступ (тайный гость, проверяющий)',
    permissions: ['workspace.view'] as WorkspacePermission[],
  },
} as const;

export type WorkspaceRole = keyof typeof WORKSPACE_ROLES;

// Роли в circle (context = "circle", tenantId = circle_id)
export const CIRCLE_ROLES = {
  owner: {
    name: 'Создатель',
    description: 'Создатель окружения',
    permissions: ['circle.manage', 'circle.members', 'circle.delete'] as CirclePermission[],
  },
  member: {
    name: 'Участник',
    description: 'Участник окружения',
    permissions: ['circle.view', 'circle.tasks'] as CirclePermission[],
  },
} as const;

export type CircleRole = keyof typeof CIRCLE_ROLES;

// Разрешения по контекстам
export const SYSTEM_PERMISSIONS = {
  'users.view': 'Просмотр пользователей',
  'users.manage': 'Управление пользователями',
  'workspaces.create': 'Создание рабочих пространств',
  'workspaces.manage_all': 'Управление всеми пространствами',
  'circles.create': 'Создание окружений',
  'subscriptions.manage': 'Управление подписками',
  'admin.access': 'Доступ к админ-панели',
  'admin.full': 'Полный доступ администратора',
} as const;

export type SystemPermission = keyof typeof SYSTEM_PERMISSIONS;

export const WORKSPACE_PERMISSIONS = {
  'workspace.manage': 'Управление пространством',
  'workspace.delete': 'Удаление пространства',
  'workspace.members': 'Управление участниками',
  'workspace.members.view': 'Просмотр участников',
  'workspace.tasks': 'Управление всеми задачами',
  'workspace.tasks.own': 'Управление своими задачами',
  'workspace.view': 'Просмотр пространства',
} as const;

export type WorkspacePermission = keyof typeof WORKSPACE_PERMISSIONS;

export const CIRCLE_PERMISSIONS = {
  'circle.manage': 'Управление окружением',
  'circle.delete': 'Удаление окружения',
  'circle.members': 'Управление участниками',
  'circle.view': 'Просмотр окружения',
  'circle.tasks': 'Задачи в окружении',
} as const;

export type CirclePermission = keyof typeof CIRCLE_PERMISSIONS;

// Интерфейс роли пользователя
export interface UserRoleRecord {
  id: string;
  userId: string;
  role: string;
  context: RoleContext;
  tenantId: string | null;
  grantedAt: string;
  grantedBy: string | null;
  isActive: boolean;
}
