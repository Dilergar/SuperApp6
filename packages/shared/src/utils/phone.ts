/**
 * Normalize phone number to +7XXXXXXXXXX format
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.startsWith('8') && digits.length === 11) {
    return '+7' + digits.slice(1);
  }
  if (digits.startsWith('7') && digits.length === 11) {
    return '+' + digits;
  }
  if (digits.length === 10) {
    return '+7' + digits;
  }

  return '+' + digits;
}

/**
 * Format phone for display: +7 (XXX) XXX-XX-XX
 */
export function formatPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  const digits = normalized.replace(/\D/g, '');

  if (digits.length === 11) {
    return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
  }

  return normalized;
}

/**
 * Mask phone for privacy: +7 (***) ***-**-45
 */
export function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (normalized.length >= 4) {
    return normalized.slice(0, -4).replace(/\d/g, '*') + normalized.slice(-4);
  }
  return normalized;
}
