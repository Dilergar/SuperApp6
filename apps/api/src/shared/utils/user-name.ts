/**
 * A user's display name from first/last name, with a fallback when the user is missing.
 * Single source of truth — services used to each define their own copy of this.
 */
export function fullName(
  u: { firstName: string; lastName: string | null } | null | undefined,
  fallback = 'Пользователь',
): string {
  if (!u) return fallback;
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.firstName || fallback;
}
