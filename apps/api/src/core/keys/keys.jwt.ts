import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

// ============================================================
// Компактный JWS (RFC 7515/7519) на node:crypto — без внешней библиотеки.
//
// Почему не jsonwebtoken: он не умеет EdDSA. Почему не jose: своя реализация —
// это ~100 строк, и в ней физически нет `alg: none`, ключей из заголовка
// (`jku`/`jwk`/`x5u`/`x5c`) и алгоритмов вне allow-list. Верификатор принимает
// EdDSA (по `kid` из keystore) и — только на окне миграции — HS256.
// ============================================================

export type JwsAlg = 'EdDSA' | 'HS256';

export interface JwsHeader {
  alg: JwsAlg;
  typ?: string;
  kid?: string;
}

export interface JwtStdClaims {
  iat?: number;
  exp?: number;
  nbf?: number;
  aud?: string | string[];
  sub?: string;
  jti?: string;
}

export interface ParsedJws {
  header: JwsHeader;
  payload: Record<string, unknown> & JwtStdClaims;
  signature: Buffer;
  /** `<b64 header>.<b64 payload>` — то, что подписано */
  signingInput: string;
}

/** Поля заголовка, которые заставляют верификатор брать ключ из самого токена — запрещены. */
const FORBIDDEN_HEADER_FIELDS = ['jku', 'jwk', 'x5u', 'x5c', 'crit'];

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function encodeJws(header: JwsHeader, payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
}

/** Разбор без проверки подписи; `null` — формат не наш (три сегмента, JSON, alg из allow-list). */
export function parseJws(token: string): ParsedJws | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (header.alg !== 'EdDSA' && header.alg !== 'HS256') return null;
  for (const f of FORBIDDEN_HEADER_FIELDS) if (f in header) return null;
  if (header.kid !== undefined && (typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(header.kid))) return null;
  return {
    header: { alg: header.alg, typ: typeof header.typ === 'string' ? header.typ : undefined, kid: header.kid as string | undefined },
    payload: payload as ParsedJws['payload'],
    signature: b64urlDecode(parts[2]),
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

export function generateEd25519(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
  };
}

export function ed25519Sign(pkcs8: Buffer, data: Buffer): Buffer {
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, data, key);
}

export function ed25519Verify(spki: Buffer, data: Buffer, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
}

/** Сырые 32 байта публичного ключа Ed25519 из SPKI DER (последние 32 байта) — `x` в JWK. */
export function ed25519RawPublic(spki: Buffer): Buffer {
  return spki.subarray(spki.length - 32);
}

export function hs256(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export function bufEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Запись `ms`/jsonwebtoken (`15m`, `30d`, `2 days`, `8h`, `900`) → секунды. Число без
 * единицы — секунды (правило jsonwebtoken). Нераспознанное → null (вызывающий берёт дефолт).
 */
export function parseDurationSec(input: string | undefined | null): number | null {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = { ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800, y: 31557600, yr: 31557600, yrs: 31557600, year: 31557600, years: 31557600 };
  return Math.round(n * (mult[unit] ?? 1));
}
