// Короткие конструкторы частей политики — чтобы 200+ записей реестра читались глазами.
// Семантику не прячут: каждое имя = ровно один литерал из `types.ts`.
import {
  LIFECYCLE_FOREVER,
  type LifecycleCitation,
  type LifecycleDuration,
  type LifecycleEdge,
  type LifecycleEdgeKind,
  type LifecycleEnforcement,
  type LifecycleLegalBasis,
  type LifecycleOwnerKind,
  type LifecycleOwnerKey,
  type LifecycleRetention,
  type LifecycleRetentionTrigger,
  type LifecycleRowFilter,
  type LifecycleSubject,
  type LifecycleSubjectErasure,
  type LifecycleSubjectRole,
  type LifecycleTenantPurge,
} from './types';

export const FOREVER = LIFECYCLE_FOREVER;

// ---- основание ----
export const CONSENT: LifecycleLegalBasis = { kind: 'consent' };
export const CONTRACT: LifecycleLegalBasis = { kind: 'contract' };
export const law = (citation: LifecycleCitation): LifecycleLegalBasis => ({ kind: 'legal_obligation', citation });
export const interest = (reason: string): LifecycleLegalBasis => ({ kind: 'legitimate_interest', reason });

// ---- владелец ----
export const byUser = (column: string): LifecycleOwnerKey => ({ kind: 'user', column });
export const byWorkspace = (column = 'workspaceId'): LifecycleOwnerKey => ({ kind: 'workspace', column });
export const byChat = (column = 'chatId'): LifecycleOwnerKey => ({ kind: 'conversation', column });
export const via = (kind: Exclude<LifecycleOwnerKind, 'global'>, parent: string): LifecycleOwnerKey => ({ kind, via: parent });
export const polymorphic = (
  kinds: readonly Exclude<LifecycleOwnerKind, 'global'>[] = ['user', 'workspace'],
  typeColumn = 'ownerType',
  column = 'ownerId',
): LifecycleOwnerKey => ({ kind: 'polymorphic', typeColumn, column, kinds });
export const scoped = (workspaceColumn = 'workspaceId', userColumn?: string, conversationColumn?: string): LifecycleOwnerKey => ({
  kind: 'scoped',
  workspaceColumn,
  ...(userColumn ? { userColumn } : {}),
  ...(conversationColumn ? { conversationColumn } : {}),
});
export const global = (reason: string): LifecycleOwnerKey => ({ kind: 'global', reason });

// ---- субъекты ----
export const subject = (column: string, role: LifecycleSubjectRole): LifecycleSubject => ({ column, role });

// ---- срок ----
/** Хранить, пока владелец не удалит (отсчёт от создания). */
export const keep = (trigger: LifecycleRetentionTrigger = 'created'): LifecycleRetention => ({ trigger, defaultDays: FOREVER });
/** Живёт и умирает с родителем. */
export const withParent: LifecycleRetention = { trigger: 'parent', defaultDays: FOREVER };
/** Удалять через `days` суток после `trigger`. */
export const forDays = (days: number, trigger: LifecycleRetentionTrigger = 'created'): LifecycleRetention => ({ trigger, defaultDays: days });
/** Пол закона: `floor` суток, умолчание — не меньше пола. */
export const legalFloor = (floorDays: LifecycleDuration, trigger: LifecycleRetentionTrigger, defaultDays: LifecycleDuration = floorDays): LifecycleRetention => ({
  trigger,
  floorDays,
  defaultDays,
});

/** 75 лет / 5 лет / 3 года — сутки по календарю григорианского года (365.25 округлённо вверх). */
export const YEARS = (n: number): number => Math.ceil(n * 365.25);

// ---- стирание субъекта ----
export const HARD_DELETE: LifecycleSubjectErasure = { kind: 'hard_delete' };
/** Стирается только личное (строки без организации); строки организации остаются по ссылке */
export const HARD_DELETE_PERSONAL: LifecycleSubjectErasure = { kind: 'hard_delete', personalOnly: true };
/** Человек упомянут только id — томбстоун строки User рисует «Удалённый пользователь»; копий ПДн нет */
export const BY_REFERENCE: LifecycleSubjectErasure = { kind: 'none', reason: 'person referenced by id only: the User tombstone renders a deleted user' };
export const shred = (keyScope: 'user' | 'workspace' = 'user'): LifecycleSubjectErasure => ({ kind: 'crypto_shred', keyScope });
export const pseudonymize = (...fields: string[]): LifecycleSubjectErasure => ({ kind: 'pseudonymize', fields });
export const redact = (...fields: string[]): LifecycleSubjectErasure => ({ kind: 'redact', fields });
export const retainLegal = (citation: LifecycleCitation, untilDays: LifecycleDuration): LifecycleSubjectErasure => ({ kind: 'retain_legal', citation, untilDays });
export const noSubject = (reason: string): LifecycleSubjectErasure => ({ kind: 'none', reason });

// ---- удаление организации ----
export const CASCADE_FK: LifecycleTenantPurge = { kind: 'cascade_fk' };
export const NOT_TENANT: LifecycleTenantPurge = { kind: 'not_applicable' };
export const tenantHook = (key: string): LifecycleTenantPurge => ({ kind: 'registry_hook', key });
export const tenantBatched = (column = 'workspaceId'): LifecycleTenantPurge => ({ kind: 'batched_delete', column });
export const tenantRetain = (citation: LifecycleCitation, untilDays: LifecycleDuration): LifecycleTenantPurge => ({ kind: 'retain_legal', citation, untilDays });

// ---- рёбра ----
export const edge = (to: string, kind: LifecycleEdgeKind, viaColumn?: string): LifecycleEdge => (viaColumn ? { to, kind, via: viaColumn } : { to, kind });
export const deep = (to: string, viaColumn?: string): LifecycleEdge => edge(to, 'deep', viaColumn);
export const shallow = (to: string, viaColumn?: string): LifecycleEdge => edge(to, 'shallow', viaColumn);

// ---- принуждение ----
export const CASCADE: LifecycleEnforcement = { kind: 'cascade' };
export const TTL: LifecycleEnforcement = { kind: 'ttl_sweep' };
export const TRANSIENT: LifecycleEnforcement = { kind: 'transient' };
export const notEnforced = (reason: string): LifecycleEnforcement => ({ kind: 'none', reason });
export const batched = (column: string, filter?: LifecycleRowFilter, handler?: string): LifecycleEnforcement => ({
  kind: 'batched_delete',
  column,
  ...(filter ? { filter } : {}),
  ...(handler ? { handler } : {}),
});
export const dropPartition = (column: string, period: 'day' | 'month' = 'month'): LifecycleEnforcement => ({ kind: 'drop_partition', column, period });
