import type { WorkspaceCardVisibility } from '../types/workspace';

// ============================================================
// Workspace (B2B) limits — enforced in the service layer
// ============================================================

export const WORKSPACE_LIMITS = {
  // Max workspaces one user can OWN (a person may run several businesses).
  maxWorkspacesOwnedPerUser: 20,
  // Max members per workspace.
  maxMembersPerWorkspace: 1000,
  // Max outstanding pending invitations per workspace. Дневных лимитов и кулдаунов
  // НЕТ намеренно (решение продукта: «нанять всех за день») — это анти-мусорный потолок.
  maxPendingInvitationsPerWorkspace: 500,
  // Invitation TTL in days.
  invitationTtlDays: 30,
  // Page size for the members list.
  membersPageSize: 100,
  // Сколько дней деактивированная организация лежит в архиве, прежде чем её удалят
  // НАВСЕГДА (крон). Всё это время возврат — в один клик и ничего не теряется.
  archiveRetentionDays: 90,
} as const;

/**
 * За сколько дней до полного удаления предупреждать владельца. По возрастанию — крон
 * берёт ПЕРВЫЙ подходящий рубеж (`daysLeft <= m`), поэтому за один прогон уходит не
 * больше одного письма: если крон простоял неделю, человек получит актуальное
 * «остался 1 день», а не пачку из трёх просроченных предупреждений.
 */
export const WORKSPACE_ARCHIVE_WARN_DAYS = [1, 3, 7] as const;

/** Когда архивная организация будет удалена безвозвратно (archivedAt + ретеншн). */
export function workspacePurgeAt(archivedAt: Date | string): Date {
  const from = typeof archivedAt === 'string' ? new Date(archivedAt) : archivedAt;
  return new Date(from.getTime() + WORKSPACE_LIMITS.archiveRetentionDays * 24 * 3600 * 1000);
}

/** Сколько полных дней осталось до удаления (0 — «сегодня-завтра»). */
export function daysUntilPurge(purgeAt: Date | string, now: Date = new Date()): number {
  const at = typeof purgeAt === 'string' ? new Date(purgeAt) : purgeAt;
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / (24 * 3600 * 1000)));
}

// ============================================================
// Company card visibility — what members (employees) see by default.
// Always-visible regardless: name, logo. Owner/admin always see all fields.
// ============================================================

export const DEFAULT_WORKSPACE_CARD_VISIBILITY: WorkspaceCardVisibility = {
  description: true,
  industry: true,
  city: true,
  website: true,
  contactEmail: true,
  contactPhone: false, // private by default
  membersCount: false, // private by default
  requisites: true, // реквизиты печатаются на каждом счёте — сотрудникам видны
  extras: {},
};

// Merge a stored (possibly null/partial) visibility with defaults.
export function resolveWorkspaceCardVisibility(
  stored: Partial<WorkspaceCardVisibility> | null | undefined,
): WorkspaceCardVisibility {
  if (!stored) return { ...DEFAULT_WORKSPACE_CARD_VISIBILITY };
  return {
    ...DEFAULT_WORKSPACE_CARD_VISIBILITY,
    ...stored,
    extras: {
      ...(DEFAULT_WORKSPACE_CARD_VISIBILITY.extras ?? {}),
      ...(stored.extras ?? {}),
    },
  };
}
