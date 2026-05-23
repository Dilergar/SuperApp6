// ============================================================
// Contact / Group constants
// ============================================================

// Common role presets shown in the role picker. Pure suggestions —
// the user can also type any custom role. Each person has exactly ONE
// role per side, stored as a plain string on ContactLink.
export const ROLE_PRESETS: readonly string[] = [
  'Муж',
  'Жена',
  'Парень',
  'Девушка',
  'Партнёр',
  'Мама',
  'Папа',
  'Сын',
  'Дочь',
  'Брат',
  'Сестра',
  'Бабушка',
  'Дедушка',
  'Родственник',
  'Друг',
  'Подруга',
  'Коллега',
  'Начальник',
  'Подчинённый',
  'Клиент',
  'Наставник',
  'Сосед',
  'Одноклассник',
  'Однокурсник',
] as const;

// Suggested group names/colors when the user creates a new group.
export const DEFAULT_CIRCLE_PRESETS: Array<{
  name: string;
  icon: string;
  color: string;
}> = [
  { name: 'Семья', icon: '👨‍👩‍👧', color: '#c61a1e' },
  { name: 'Друзья', icon: '🤝', color: '#326a8b' },
  { name: 'Работа', icon: '💼', color: '#6b7280' },
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
  // Page size for the cursor-paginated "Моё окружение" list.
  contactsPageSize: 100,
} as const;
