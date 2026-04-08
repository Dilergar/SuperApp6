// ============================================================
// Contact / Circle constants
// ============================================================

import type { RelationshipType } from '../types/contact';

// Role templates grouped by relationship category. Pure suggestions —
// users can enter any custom string. Stored as plain strings on ContactLink.
export const RELATIONSHIP_TEMPLATES: Record<RelationshipType, readonly string[]> = {
  family: [
    'мама',
    'папа',
    'сын',
    'дочь',
    'брат',
    'сестра',
    'бабушка',
    'дедушка',
    'тётя',
    'дядя',
    'племянник',
    'племянница',
  ],
  romantic: ['жена', 'муж', 'девушка', 'парень', 'партнёр'],
  friend: ['друг', 'подруга', 'лучший друг', 'лучшая подруга'],
  professional: [
    'коллега',
    'руководитель',
    'подчинённый',
    'клиент',
    'наставник',
    'партнёр',
  ],
  acquaintance: ['сосед', 'сосед по спортзалу', 'одноклассник', 'одногруппник'],
  other: [],
} as const;

// Default circle presets created for a new user on first contact add.
// Empty by default — user creates their own. Left here so a future migration
// can seed them if we decide to.
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
  // Max circles per owner — protects against runaway UX churn.
  maxCirclesPerUser: 50,
  // Max members per circle.
  maxMembersPerCircle: 500,
  // Max outstanding pending invitations a user can have OUTGOING.
  maxPendingOutgoingInvitations: 100,
  // Invitation TTL in days.
  invitationTtlDays: 30,
  // Throttle: max invitations a user can send per 24h to prevent spam.
  maxInvitationsPer24h: 30,
  // Cooldown (in hours) before a cancelled/rejected invitation to the same phone can be resent.
  resendCooldownHours: 0.003, // ~10 seconds (for dev testing, change to 24 for prod)
} as const;
