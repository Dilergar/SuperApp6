/**
 * A user's display name from first/last name, with a fallback when the user is missing.
 * Single source of truth — services used to each define their own copy of this.
 *
 * The default fallback is in the SOURCE locale: it is the right word for a snapshot
 * written to the database (a chronicle actor name outlives the account). Whoever shows
 * the result to a person LIVE passes the translated word instead —
 * `i18n.translate('common.labels.someone')`.
 */
export function fullName(
  u: { firstName: string; lastName: string | null } | null | undefined,
  fallback = 'Someone',
): string {
  if (!u) return fallback;
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.firstName || fallback;
}
