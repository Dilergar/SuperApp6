// ============================================================
// User, profile, contact card visibility
// ============================================================

export interface User {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  dateOfBirth: string | null; // ISO date (YYYY-MM-DD)
  avatar: string | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null; // single, married, relationship, divorced, widowed, null
  socialLinks: SocialLinks | null;
  onlineStatusMode: string; // everyone, contacts, nobody
  isVerified: boolean;
  locale: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialLinks {
  telegram?: string;
  instagram?: string;
  linkedin?: string;
  whatsapp?: string;
}

export interface UserProfile extends User {
  circlesCount: number;
  workspacesCount: number;
  contactsCount: number;
  activeSubscription: SubscriptionInfo | null;
  cardVisibility: CardVisibility; // always resolved (defaults merged in)
  roles: UserRoleInfo[];
}

export interface UserRoleInfo {
  role: string;
  context: string;
  tenantId: string | null;
}

export interface SubscriptionInfo {
  id: string;
  plan: 'free' | 'personal' | 'family' | 'business';
  status: 'active' | 'trial' | 'expired' | 'cancelled';
  expiresAt: string;
  giftedBy: string | null;
}

// ============================================================
// Contact card visibility
// ============================================================
// Always-visible on your card (regardless of flags):
//   firstName, lastName, phone, role (the label your contact gave you)
// Everything else is per-field toggleable by the card owner.
// A `null` stored in DB means "use defaults" — resolver in API merges with DEFAULT_CARD_VISIBILITY.

export interface CardVisibility {
  dateOfBirth: boolean;
  age: boolean;
  onlineStatus: boolean;
  maritalStatus: boolean;
  city: boolean;
  bio: boolean;
  email: boolean;
  socialLinks: boolean;
  // Future-proof extension bag — per-field flags added later without schema migration
  extras?: Record<string, boolean>;
}
