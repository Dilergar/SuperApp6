// ============================================================
// Name helpers
// ============================================================

/**
 * Mask a last name to its initial: "Нурланов" → "Н." (Kaspi-style).
 * Used wherever a person is shown to someone NOT (yet) linked with them:
 * the phone-lookup in the invite form, the blocked-users list.
 */
export function maskLastName(lastName: string | null | undefined): string | null {
  if (!lastName) return null;
  return `${lastName.charAt(0).toUpperCase()}.`;
}
