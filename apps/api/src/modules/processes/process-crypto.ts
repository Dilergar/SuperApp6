import { createHash } from 'node:crypto';
import type { KeysEnvelopeService } from '../../core/keys/keys.envelope.service';
import type { KeysMacService } from '../../core/keys/keys.mac.service';
import { isLegacyAesField, legacyAesDecrypt, legacySha256Key } from '../../core/keys/keys.legacy';

// ============================================================
// Сейф кредов Процессов — envelope core/keys (KEK организации, AAD = кред + поле).
// Прошлый формат (AES-256-GCM производным от мастер-секрета ключом,
// `base64(iv).base64(tag).base64(ct)`) читается на legacy-окне и перешивается джобом
// `keys.legacy.reencrypt` (колонка зарегистрирована в KeysFieldRegistry).
// ============================================================

export const PROCESS_CREDENTIAL_ENTITY = 'process_credential';
const LEGACY_KEY_PREFIX = 'process-cred:';

export function credentialCtx(workspaceId: string) {
  return { entity: PROCESS_CREDENTIAL_ENTITY, field: 'data', ownerType: 'workspace', ownerId: workspaceId };
}

export function encryptCredential(keys: KeysEnvelopeService, workspaceId: string, plaintext: string): Promise<string> {
  return keys.encrypt({ type: 'workspace', id: workspaceId }, credentialCtx(workspaceId), plaintext);
}

/** Расшифровать секрет креда: новый формат — envelope; прошлый — только пока открыто legacy-окно. */
export async function decryptCredential(keys: KeysEnvelopeService, cred: { workspaceId: string; data: string }): Promise<string> {
  if (keys.isEnvelope(cred.data)) return keys.decrypt({ type: 'workspace', id: cred.workspaceId }, credentialCtx(cred.workspaceId), cred.data);
  const legacy = legacyCredentialPlain(cred.data);
  if (legacy === null) throw new Error('the stored secret is damaged or its legacy window is closed');
  return legacy;
}

/** Открытый текст креда прошлого формата (для джоба перешивки); null — не legacy или окно закрыто. */
export function legacyCredentialPlain(stored: string): string | null {
  if (!isLegacyAesField(stored)) return null;
  const key = legacySha256Key(LEGACY_KEY_PREFIX);
  if (!key) return null;
  try {
    return legacyAesDecrypt(key, stored);
  } catch {
    return null;
  }
}

// ---- Публичный вебхук: токен в URL, хеш в БД, сам токен — envelope для показа редакторам ----

export const PROCESS_TRIGGER_ENTITY = 'process_trigger';

/** Детерминированный хеш токена вебхука (lookup по unique-колонке; токен — 24 байта CSPRNG). */
export function hashWebhookToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Хеш токена — 64 hex; сырой токен прошлой эпохи — 32 символа base64url. */
export function isHashedWebhookToken(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}

export function webhookTokenCtx(workspaceId: string) {
  return { entity: PROCESS_TRIGGER_ENTITY, field: 'webhook_token', ownerType: 'workspace', ownerId: workspaceId };
}

/**
 * `secret_token` Telegram для setWebhook: HMAC pepper-ключом keystore над сырым токеном
 * пути (Telegram допускает `A-Za-z0-9_-`, 1–256 символов). Приёмник сверяет заголовок
 * `X-Telegram-Bot-Api-Secret-Token` любой активной версией ключа.
 */
export async function telegramSecretFor(mac: KeysMacService, rawToken: string): Promise<string> {
  const { mac: digest } = await mac.mac('api_key_pepper', `telegram|${rawToken}`);
  return digest.toString('base64url');
}

export async function telegramSecretMatches(mac: KeysMacService, rawToken: string, header: string | undefined): Promise<boolean> {
  if (!header || !/^[A-Za-z0-9_-]{20,256}$/.test(header)) return false;
  return mac.verifyAny('api_key_pepper', `telegram|${rawToken}`, Buffer.from(header, 'base64url'));
}
