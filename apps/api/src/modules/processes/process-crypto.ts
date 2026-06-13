import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Сейф кредов: AES-256-GCM. Ключ выводится из JWT_SECRET (отдельная env-переменная
// не нужна; ротация секрета сделает старые креды нечитаемыми — это приемлемо для MVP).
// Формат строки в БД: base64(iv).base64(tag).base64(ciphertext) — секрет наружу не отдаётся.

function key(): Buffer {
  const secret = process.env.JWT_SECRET || 'dev-only-secret';
  return createHash('sha256').update(`process-cred:${secret}`).digest(); // 32 байта
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Повреждённый секрет');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
