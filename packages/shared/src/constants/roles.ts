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

// Reserved system-context role for the future Jobs Marketplace: the "Тайный гость"
// qualification (a platform-wide credential earned via training), distinct from the
// per-workspace `contractor` engagement role. The marketplace is NOT built yet — this only
// reserves the value so the identity model accommodates it without a later migration.
export const MYSTERY_SHOPPER_SYSTEM_ROLE = 'mystery_shopper' as const;

// Роли в workspace (context = "workspace", tenantId = workspace_id).
// Лестница (одна роль на организацию): contractor < trainee < staff < manager < admin < owner.
// Найм ВСЕГДА в trainee (приглашение не несёт выбора роли); повышение — вручную
// (позже — бизнес-процессами/Додзё). Должности/отделы/филиалы — отдельные сущности
// (StaffModule), роль прав они не несут.
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
    description: 'Управляет сотрудниками: справочники, должности, наём',
    permissions: ['workspace.members.view', 'workspace.tasks', 'workspace.staff.manage'] as WorkspacePermission[],
  },
  staff: {
    name: 'Сотрудник',
    description: 'Полноценный сотрудник',
    permissions: ['workspace.tasks.own', 'workspace.members.view'] as WorkspacePermission[],
  },
  trainee: {
    name: 'Стажёр',
    description: 'Новый сотрудник: проходит обучение (Додзё) своей должности',
    permissions: ['workspace.tasks.own', 'workspace.members.view'] as WorkspacePermission[],
  },
  contractor: {
    name: 'Подрядчик',
    description:
      'Внешний исполнитель (Коллаб-модель): доступ только к явно выданным задачам/чатам. ' +
      'Назначается сервисами (Тайный гость, UGC), не вручную',
    permissions: [] as WorkspacePermission[],
  },
} as const;

export type WorkspaceRole = keyof typeof WORKSPACE_ROLES;

// Единый источник лестницы (больше = сильнее). Используется для сравнений прав.
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 6,
  admin: 5,
  manager: 4,
  staff: 3,
  trainee: 2,
  contractor: 1,
} as const;

// Роль, в которую попадает КАЖДЫЙ наём (выбора роли в приглашении нет).
export const WORKSPACE_HIRE_ROLE = 'trainee' as const;

// Какие роли можно выставить вручную. owner исключён (только transfer);
// contractor исключён (только программно через сервисы — Тайный гость/UGC).
// Админа назначает/снимает ТОЛЬКО владелец; админ управляет ролями ниже админа.
export const OWNER_ASSIGNABLE_WORKSPACE_ROLES = ['admin', 'manager', 'staff', 'trainee'] as const;
export const ADMIN_ASSIGNABLE_WORKSPACE_ROLES = ['manager', 'staff', 'trainee'] as const;

// Роли «в команде» (видят ростер, участвуют в «рабочем пропуске»).
// contractor сюда НЕ входит — он изолирован до явных выдач доступа.
export const TEAM_WORKSPACE_ROLES = ['owner', 'admin', 'manager', 'staff', 'trainee'] as const;

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
  'workspace.staff.manage': 'Управление сотрудниками (справочники, должности, наём)',
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
