import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { keysEnv, legacyHs256Open } from './keys.env';

// ============================================================
// Legacy-окно: артефакты эпохи мастер-секрета `JWT_SECRET`.
//
// До движка ключей девять потребителей выводили свои ключи из одного секрета
// (подпись HS256, HMAC OTP-кодов, state OAuth, HMAC-ссылки файлов, AES сейфов).
// Всё это читается ЗДЕСЬ и только здесь (ESLint-страж), только пока открыто окно
// `KEYS_LEGACY_HS256_UNTIL`, и только для ПРОВЕРКИ/РАСШИФРОВКИ старых значений —
// новые артефакты никогда не создаются производными ключами.
// ============================================================

/** Секрет прошлой эпохи (`JWT_SECRET_LEGACY`, устаревший синоним `JWT_SECRET`); null — окна нет. */
export function legacySecret(): string | null {
  const env = keysEnv();
  return legacyHs256Open(env) ? env.legacySecret : null;
}

/** Открыто ли окно legacy-артефактов (та же дата, что у HS256). */
export function legacyOpen(): boolean {
  return legacyHs256Open();
}

/** `createHmac(secret).update(context).hex` — так выводился секрет кабинета платформы. */
export function legacyDerivedHexSecret(context: string): string | null {
  const s = legacySecret();
  return s ? createHmac('sha256', s).update(context).digest('hex') : null;
}

/** `createHmac(secret).update(context)` сырыми байтами — ключи WOPI-токенов и гостевых пропусков. */
export function legacyDerivedKey(context: string): Buffer | null {
  const s = legacySecret();
  return s ? createHmac('sha256', s).update(context).digest() : null;
}

/** `sha256(prefix + secret)` — ключи HMAC-ссылок файлов (`files:`) и AES-сейфов (`process-cred:`, `field:<ctx>:`). */
export function legacySha256Key(prefix: string): Buffer | null {
  const s = legacySecret();
  return s ? createHash('sha256').update(`${prefix}${s}`).digest() : null;
}

/** HMAC-SHA256 строкой-ключом `${prefix}${secret}` (коды OTP: `verify:`). */
export function legacyHmacWithPrefix(prefix: string, data: string): Buffer | null {
  const s = legacySecret();
  return s ? createHmac('sha256', `${prefix}${s}`).update(data).digest() : null;
}

/** HMAC-SHA256 самим секретом (state Google: `JWT_SECRET || 'dev'`). */
export function legacyHmacRaw(data: string): Buffer | null {
  const s = legacySecret();
  return s ? createHmac('sha256', s).update(data).digest() : null;
}

/** Формат сейфов прошлой эпохи: `base64(iv).base64(tag).base64(ct)` — AES-256-GCM без AAD. */
export function isLegacyAesField(stored: string): boolean {
  const parts = stored.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9+/=]+$/.test(p));
}

export function legacyAesDecrypt(key: Buffer, stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('the legacy encrypted field is corrupted');
  // Тег — строго 16 байт: GCM в Node без `authTagLength` принимает и 4-байтовый тег, а его
  // подделка перебирается (значение колонки приходит из БД, но сейф обязан держаться и тогда)
  const tag = Buffer.from(tagB64, 'base64');
  if (tag.length !== 16) throw new Error('the legacy encrypted field is corrupted');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Только для сьюта/учений: собрать legacy-шифротекст, чтобы проверить перешивку. */
export function legacyAesEncryptForTests(key: Buffer, plaintext: string, iv: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
