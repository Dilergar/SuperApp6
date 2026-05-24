import type { WorkspaceCardVisibility } from '../types/workspace';

// ============================================================
// Workspace (B2B) limits — enforced in the service layer
// ============================================================

export const WORKSPACE_LIMITS = {
  // Max workspaces one user can OWN (a person may run several businesses).
  maxWorkspacesOwnedPerUser: 20,
  // Max members per workspace.
  maxMembersPerWorkspace: 1000,
  // Max outstanding pending invitations per workspace.
  maxPendingInvitationsPerWorkspace: 200,
  // Invitation TTL in days.
  invitationTtlDays: 30,
  // Throttle: max invitations a workspace can send per 24h (anti-spam).
  maxInvitationsPer24h: 50,
  // Cooldown (hours) before re-inviting the same phone to the same workspace.
  resendCooldownHours: 24,
  // Page size for the members list.
  membersPageSize: 100,
} as const;

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
