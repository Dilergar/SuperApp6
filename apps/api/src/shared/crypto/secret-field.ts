import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// ============================================================
// Шифрование отдельного ПОЛЯ в БД — AES-256-GCM.
//
// Обобщение сейфа кредов Процессов (process-crypto.ts): тот же алгоритм и формат,
// но ключ выводится из JWT_SECRET ОТДЕЛЬНОЙ строкой контекста на каждого
// потребителя — утечка расшифровки одного класса полей не открывает другой.
// В production env-валидация требует JWT_SECRET ≥ 32 символов.
//
// Формат строки в БД: base64(iv).base64(tag).base64(ciphertext).
// ============================================================

function keyFor(context: string): Buffer {
  const secret = process.env.JWT_SECRET || 'dev-only-secret';
  return createHash('sha256').update(`field:${context}:${secret}`).digest(); // 32 байта
}

export function encryptField(context: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(context), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptField(context: string, stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Повреждённое зашифрованное поле');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(context), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
