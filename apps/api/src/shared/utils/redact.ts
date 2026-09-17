// ============================================================
// Маскирование секретов в логах — обязательно везде, где в лог попадают
// заголовки или тела запросов (фильтр исключений, логи вебхуков и джобов).
// Отдельного логгера в API нет (Nest `Logger`), поэтому хелпер — единственная
// точка, и его отсутствие в новом месте видно на ревью по ключевому слову.
// ============================================================

/** Ключи API/вебхуков движка (`sa6_bot_live_…`), Bearer-токены, значения Authorization/cookie, JWT. */
const PATTERNS: Array<[RegExp, string]> = [
  [/sa6_[a-z]+_[a-z]+_[A-Za-z0-9]{6,}/g, 'sa6_***'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/("?(?:authorization|cookie|set-cookie|x-api-key|x-telegram-bot-api-secret-token|password|refreshToken|accessToken|verifyToken|secret)"?\s*[:=]\s*"?)([^",\s}]+)/gi, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt.***'],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Безопасный снимок объекта (заголовки, тело) для лога. */
export function redactObject(value: unknown, maxLen = 2000): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const redacted = redactSecrets(text ?? '');
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted;
}
