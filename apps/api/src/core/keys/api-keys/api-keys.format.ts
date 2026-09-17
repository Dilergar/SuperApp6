import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KEYS_ARTIFACT_PREFIX, KEYS_LIMITS, type ApiKeyEnv, type ApiKeyKind } from '@superapp/shared';

// ============================================================
// Формат секрета ключа API (модель GitHub/Stripe): `sa6_<тип>_<среда>_<base62 ×43>_<crc32 base62 ×6>`.
// Префикс узнаваем сканерами (gitleaks, GitHub secret scanning), контрольная сумма отсекает
// опечатки без похода в БД, среда `test` видна в чужом коде с первого взгляда. В БД —
// только HMAC-SHA256 pepper-ключом keystore (lookup по хешу), префикс и last4 для маски.
// ============================================================

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PREFIX = KEYS_ARTIFACT_PREFIX.apiKey;
const RE = /^sa6_(bot|pat|whs)_(live|test)_([0-9A-Za-z]{40,48})_([0-9A-Za-z]{6})$/;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(input: string): number {
  let crc = 0xffffffff;
  const bytes = Buffer.from(input, 'utf8');
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function base62(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'));
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

function base62Fixed(n: number, width: number): string {
  let v = n >>> 0;
  let out = '';
  for (let i = 0; i < width; i++) {
    out = ALPHABET[v % 62] + out;
    v = Math.floor(v / 62);
  }
  return out;
}

export interface GeneratedSecret {
  secret: string;
  /** `sa6_bot_live_ab12` — показывается в реестре */
  prefix: string;
  last4: string;
}

export function generateApiSecret(kind: ApiKeyKind, env: ApiKeyEnv): GeneratedSecret {
  const body = base62(randomBytes(KEYS_LIMITS.secretBytes)).padStart(43, '0');
  const head = `${PREFIX}_${kind}_${env}_${body}`;
  const secret = `${head}_${base62Fixed(crc32(head), 6)}`;
  return { secret, prefix: `${PREFIX}_${kind}_${env}_${body.slice(0, 4)}`, last4: body.slice(-KEYS_LIMITS.last4) };
}

export interface ParsedSecret {
  kind: ApiKeyKind;
  env: ApiKeyEnv;
  body: string;
  prefix: string;
}

/** Формат и контрольная сумма; `null` — не наш ключ (ответ одинаков для опечатки и подделки). */
export function parseApiSecret(raw: string): ParsedSecret | null {
  const m = RE.exec(raw);
  if (!m) return null;
  const kind = m[1] as ApiKeyKind;
  const env = m[2] as ApiKeyEnv;
  const body = m[3]!;
  const head = `${PREFIX}_${kind}_${env}_${body}`;
  const expected = Buffer.from(base62Fixed(crc32(head), 6));
  const got = Buffer.from(m[4]!);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { kind, env, body, prefix: `${PREFIX}_${kind}_${env}_${body.slice(0, 4)}` };
}

/** Префикс для счётчика отказов (IP + префикс): даже у невалидной строки — первые символы. */
export function roughPrefix(raw: string): string {
  return raw.slice(0, 20).replace(/[^A-Za-z0-9_]/g, '');
}

export function hashApiSecret(pepper: Buffer, secret: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}
