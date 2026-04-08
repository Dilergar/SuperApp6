// ============================================================
// Default card visibility
// ============================================================
// Always-visible (regardless of these flags): firstName, lastName, phone, role.
// These flags apply only to the OPTIONAL profile fields.
// Owner can override via PATCH /users/me → cardVisibility.

import type { CardVisibility } from '../types/user';

export const DEFAULT_CARD_VISIBILITY: CardVisibility = {
  dateOfBirth: false, // private by default — many users dislike showing DoB
  age: true, // derived from DoB, coarse enough to be public-ish
  onlineStatus: true,
  maritalStatus: false,
  city: true,
  bio: true,
  email: false, // private by default
  socialLinks: true,
  extras: {},
};

// Merge stored (possibly null) visibility with defaults.
export function resolveCardVisibility(
  stored: Partial<CardVisibility> | null | undefined
): CardVisibility {
  if (!stored) return { ...DEFAULT_CARD_VISIBILITY };
  return {
    ...DEFAULT_CARD_VISIBILITY,
    ...stored,
    extras: { ...(DEFAULT_CARD_VISIBILITY.extras ?? {}), ...(stored.extras ?? {}) },
  };
}
