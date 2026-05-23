// ============================================================
// Card visibility
// ============================================================
// Always-visible (regardless of these flags): firstName, lastName,
// phone, role. These flags apply only to the OPTIONAL profile fields.
//
// Visibility is configured PER GROUP (Circle): each group the owner
// creates has its own CardVisibility. When a viewer is in several of
// the owner's groups, the effective visibility is the UNION
// (mergeVisibilities). A viewer in no group falls back to the owner's
// default visibility (users.card_visibility, a single CardVisibility).

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

// Merge a stored (possibly null/partial) visibility with defaults.
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

// Union of several resolved visibilities: a field is visible if ANY of
// the viewer's groups makes it visible. Base is all-OFF, then OR each.
export function mergeVisibilities(list: CardVisibility[]): CardVisibility {
  if (list.length === 0) return { ...DEFAULT_CARD_VISIBILITY };
  const out: CardVisibility = {
    dateOfBirth: false,
    age: false,
    onlineStatus: false,
    maritalStatus: false,
    city: false,
    bio: false,
    email: false,
    socialLinks: false,
    extras: {},
  };
  for (const v of list) {
    out.dateOfBirth ||= v.dateOfBirth;
    out.age ||= v.age;
    out.onlineStatus ||= v.onlineStatus;
    out.maritalStatus ||= v.maritalStatus;
    out.city ||= v.city;
    out.bio ||= v.bio;
    out.email ||= v.email;
    out.socialLinks ||= v.socialLinks;
    for (const [k, val] of Object.entries(v.extras ?? {})) {
      out.extras![k] ||= val;
    }
  }
  return out;
}
