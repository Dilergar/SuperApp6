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

// Системные роли (context = "system", tenantId = null).
//
// Реестр несёт ПРАВА, а не слова: имя роли живёт в каталоге
// (`common.role.system.<key>`), потому что оно показывается человеку — в
// профиле, на Главной и в карточке организации, — и обязано говорить на его
// языке. Описания ролей отсюда убраны: их не показывал никто.
export const SYSTEM_ROLES = {
  user: {
    permissions: ['workspaces.create', 'circles.create'] as SystemPermission[],
  },
  moderator: {
    permissions: ['users.view', 'workspaces.create', 'circles.create'] as SystemPermission[],
  },
  admin: {
    permissions: [
      'users.view',
      'users.manage',
      'workspaces.create',
      'workspaces.manage_all',
      'subscriptions.manage',
      'admin.access',
      'admin.full',
    ] as SystemPermission[],
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
// Имена ступеней — `common.role.workspace.<key>` в каталоге.
export const WORKSPACE_ROLES = {
  owner: {
    permissions: ['workspace.manage', 'workspace.members', 'workspace.tasks', 'workspace.delete'] as WorkspacePermission[],
  },
  admin: {
    permissions: ['workspace.manage', 'workspace.members', 'workspace.tasks'] as WorkspacePermission[],
  },
  manager: {
    permissions: ['workspace.members.view', 'workspace.tasks', 'workspace.staff.manage'] as WorkspacePermission[],
  },
  staff: {
    permissions: ['workspace.tasks.own', 'workspace.members.view'] as WorkspacePermission[],
  },
  trainee: {
    permissions: ['workspace.tasks.own', 'workspace.members.view'] as WorkspacePermission[],
  },
  // Внешний исполнитель (Коллаб-модель): доступ только к явно выданным
  // задачам/чатам. Назначается сервисами (Тайный гость, UGC), не вручную.
  contractor: {
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

// Роли в circle (context = "circle", tenantId = circle_id).
// Имена — `common.role.circle.<key>`.
export const CIRCLE_ROLES = {
  owner: {
    permissions: ['circle.manage', 'circle.members', 'circle.delete'] as CirclePermission[],
  },
  member: {
    permissions: ['circle.view', 'circle.tasks'] as CirclePermission[],
  },
} as const;

export type CircleRole = keyof typeof CIRCLE_ROLES;

// Разрешения по контекстам — это КЛЮЧИ, а не подписи: человеку разрешения
// нигде не показываются (в профиле видна роль, а не её состав), и их русские
// описания были мёртвым текстом.
export const SYSTEM_PERMISSIONS = [
  'users.view',
  'users.manage',
  'workspaces.create',
  'workspaces.manage_all',
  'circles.create',
  'subscriptions.manage',
  'admin.access',
  'admin.full',
] as const;

export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];

export const WORKSPACE_PERMISSIONS = [
  'workspace.manage',
  'workspace.delete',
  'workspace.members',
  'workspace.members.view',
  'workspace.staff.manage',
  'workspace.tasks',
  'workspace.tasks.own',
  'workspace.view',
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

export const CIRCLE_PERMISSIONS = [
  'circle.manage',
  'circle.delete',
  'circle.members',
  'circle.view',
  'circle.tasks',
] as const;

export type CirclePermission = (typeof CIRCLE_PERMISSIONS)[number];

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
