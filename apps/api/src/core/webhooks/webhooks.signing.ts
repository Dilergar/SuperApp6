import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_HEADERS } from '@superapp/shared';
import { ed25519Sign, ed25519Verify } from '../keys/keys.jwt';

/**
 * Подпись Standard Webhooks (https://www.standardwebhooks.com): заголовки
 * `webhook-id`, `webhook-timestamp`, `webhook-signature`; подписываемая строка —
 * `<id>.<timestamp>.<raw body>`; значения `v1,<base64>` (HMAC-SHA256 секретом) и
 * `v1a,<base64>` (Ed25519 ключом endpoint'а), через пробел — по одному на каждый живой
 * секрет (ротация с перекрытием: получатель принимает любую совпавшую).
 *
 * Ключ HMAC — UTF-8 байты секрета `sa6_whs_…` целиком (у нас нет префикса `whsec_`
 * с base64 внутри; документируется в docs/webhooks_engine.md).
 */

export function signedContent(id: string, timestampSec: number, body: string): string {
  return `${id}.${timestampSec}.${body}`;
}

export function hmacSignature(secret: string, content: string): string {
  return `v1,${createHmac('sha256', Buffer.from(secret, 'utf8')).update(content, 'utf8').digest('base64')}`;
}

export function ed25519Signature(pkcs8: Buffer, content: string): string {
  return `v1a,${ed25519Sign(pkcs8, Buffer.from(content, 'utf8')).toString('base64')}`;
}

export interface SigningMaterial {
  /** Живые HMAC-секреты: текущий и, до `prevExpiresAt`, предыдущий */
  secrets: string[];
  /** Приватный ключ Ed25519 (pkcs8 DER) — для endpoint'ов с signing=ed25519 */
  ed25519PrivateKey?: Buffer | null;
}

export function buildSignatureHeaders(id: string, timestampSec: number, body: string, material: SigningMaterial): Record<string, string> {
  const content = signedContent(id, timestampSec, body);
  const parts = material.secrets.map((s) => hmacSignature(s, content));
  if (material.ed25519PrivateKey) parts.push(ed25519Signature(material.ed25519PrivateKey, content));
  return {
    [WEBHOOK_HEADERS.id]: id,
    [WEBHOOK_HEADERS.timestamp]: String(timestampSec),
    [WEBHOOK_HEADERS.signature]: parts.join(' '),
  };
}

/** Заведомо битая подпись для аудита получателя: та же форма, случайное содержимое. */
export function bogusSignatureHeaders(id: string, timestampSec: number): Record<string, string> {
  return {
    [WEBHOOK_HEADERS.id]: id,
    [WEBHOOK_HEADERS.timestamp]: String(timestampSec),
    [WEBHOOK_HEADERS.signature]: `v1,${randomBytes(32).toString('base64')}`,
  };
}

/**
 * Проверка на стороне получателя (референс для документации и сьюта): совпадает ли
 * хоть одна подпись заголовка с HMAC любого известного секрета либо с Ed25519 публичным
 * ключом; timestamp — в допуске.
 */
export function verifyStandardWebhook(
  headers: Record<string, string | undefined>,
  body: string,
  opts: { secrets?: string[]; ed25519PublicKeySpki?: Buffer; toleranceSec: number; nowSec?: number },
): boolean {
  const id = headers[WEBHOOK_HEADERS.id];
  const ts = Number(headers[WEBHOOK_HEADERS.timestamp]);
  const sig = headers[WEBHOOK_HEADERS.signature];
  if (!id || !Number.isFinite(ts) || !sig) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > opts.toleranceSec) return false;
  const content = signedContent(id, ts, body);
  for (const part of sig.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (!value) continue;
    if (version === 'v1') {
      for (const s of opts.secrets ?? []) {
        const expected = hmacSignature(s, content).slice(3);
        const a = Buffer.from(expected, 'base64');
        const b = Buffer.from(value, 'base64');
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
      }
    } else if (version === 'v1a' && opts.ed25519PublicKeySpki) {
      if (ed25519Verify(opts.ed25519PublicKeySpki, Buffer.from(content, 'utf8'), Buffer.from(value, 'base64'))) return true;
    }
  }
  return false;
}
