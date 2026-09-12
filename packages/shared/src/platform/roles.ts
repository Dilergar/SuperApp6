import { PLATFORM_CAPABILITIES, type PlatformCapability } from './capabilities';

// ============================================================
// Роли сотрудников платформы — «может / не может» поверх каталога capabilities
// ============================================================
// На старте одна роль — `platform_owner` (всё). Структура и реестр готовы под
// узкие роли позже (support, billing, security, auditor…): роль = строка здесь +
// `platform.roles.<key>` в трёх каталогах. Правило SoD проверяется сервером при
// НАЗНАЧЕНИИ роли и при РЕШЕНИИ заявки: один человек не пишет и не одобряет одно.
//
// У владельца SoD-исключение осознанное: единственная роль на старте обязана
// уметь и то и другое, а four-eyes включается политикой — тогда `.approve`
// решает ВТОРОЙ владелец (автор заявку себе не одобряет: гвард в исполнителе).

export interface PlatformRoleDef {
  grants: readonly PlatformCapability[];
  denies: readonly PlatformCapability[];
  labelKey: string;
  /** Роль-владелец: последнего активного носителя приостановить нельзя */
  owner?: boolean;
  /** Правило SoD не применяется (только у владельца) */
  sodExempt?: boolean;
}

export const PLATFORM_ROLES = {
  platform_owner: {
    grants: PLATFORM_CAPABILITIES,
    denies: [],
    labelKey: 'platform.roles.platform_owner',
    owner: true,
    sodExempt: true,
  },
} as const satisfies Record<string, PlatformRoleDef>;

export type PlatformRoleKey = keyof typeof PLATFORM_ROLES;
export const PLATFORM_ROLE_KEYS = Object.keys(PLATFORM_ROLES) as PlatformRoleKey[];

export function isPlatformRoleKey(value: unknown): value is PlatformRoleKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLATFORM_ROLES, value);
}

/** Эффективные capabilities набора ролей: объединение grants минус объединение denies. */
export function capabilitiesOfRoles(roles: readonly PlatformRoleKey[]): PlatformCapability[] {
  const granted = new Set<PlatformCapability>();
  const denied = new Set<PlatformCapability>();
  for (const r of roles) {
    const def: PlatformRoleDef = PLATFORM_ROLES[r];
    for (const c of def.grants) granted.add(c);
    for (const c of def.denies) denied.add(c);
  }
  return [...granted].filter((c) => !denied.has(c));
}

/** Роль-владелец кабинета? */
export function isOwnerRole(role: PlatformRoleKey): boolean {
  return !!(PLATFORM_ROLES[role] as PlatformRoleDef).owner;
}

export const PLATFORM_STAFF_STATUSES = ['active', 'suspended'] as const;
export type PlatformStaffStatus = (typeof PLATFORM_STAFF_STATUSES)[number];
