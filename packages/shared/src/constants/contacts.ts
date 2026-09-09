// ============================================================
// Contact / Group constants
// ============================================================

// Common role presets shown in the role picker. Pure suggestions —
// the user can also type any custom role. Each person has exactly ONE
// role per side, stored as a plain string on ContactLink.
//
// Реестр называет СМЫСЛ подсказки, слово даёт каталог (`circles.rolePreset.<key>`):
// сама роль в связи — ДАННЫЕ (её человек может и напечатать своими словами), а
// вот список подсказок — интерфейс, и он обязан говорить на языке зрителя.
export const ROLE_PRESET_KEYS: readonly string[] = [
  'husband',
  'wife',
  'boyfriend',
  'girlfriend',
  'partner',
  'mother',
  'father',
  'son',
  'daughter',
  'brother',
  'sister',
  'grandmother',
  'grandfather',
  'relative',
  'friend',
  'closeFriend',
  'colleague',
  'boss',
  'report',
  'client',
  'mentor',
  'neighbour',
  'schoolmate',
  'coursemate',
] as const;

// Suggested group names/colors when the user creates a new group
// (`circles.groupPreset.<key>` даёт имя).
export const DEFAULT_CIRCLE_PRESETS: Array<{
  key: string;
  icon: string;
  color: string;
}> = [
  { key: 'family', icon: '👨‍👩‍👧', color: '#de6d68' },
  { key: 'friends', icon: '🤝', color: '#588cd3' },
  { key: 'work', icon: '💼', color: '#8a8478' },
];

// ============================================================
// Limits (enforced in service layer)
// ============================================================

export const CONTACT_LIMITS = {
  // Max groups per owner — protects against runaway UX churn.
  maxCirclesPerUser: 50,
  // Max members per group.
  maxMembersPerCircle: 500,
  // Max outstanding pending invitations a user can have OUTGOING.
  maxPendingOutgoingInvitations: 100,
  // Invitation TTL in days.
  invitationTtlDays: 30,
  // Throttle: max invitations a user can send per 24h to prevent spam.
  maxInvitationsPer24h: 30,
  // Cooldown (hours) before a cancelled/rejected invitation to the same phone can be resent.
  resendCooldownHours: 24,
  // How long non-pending invitations are kept before cleanup deletes them.
  // The resend cooldown, the 24h send limit and resendInvitation all read this
  // history — it must outlive every window that depends on it.
  nonPendingRetentionDays: 30,
  // Page size for the cursor-paginated "Моё окружение" list.
  contactsPageSize: 100,
  // Page size for the cursor-paginated invitation lists (incoming / outgoing /
  // history). Incoming used to be a hard 200-row cap with no way to read further.
  invitationsPageSize: 50,
  // Защитный потолок обхода окружения там, где нужен ПОЛНЫЙ проход без курсора
  // (живой поиск по именам). Задаётся владельцем графа, а не потребителем.
  maxContactsScan: 2000,
} as const;
