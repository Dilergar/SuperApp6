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
