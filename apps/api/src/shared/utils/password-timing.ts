import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

/** Стоимость bcrypt паролей платформы — одна на все хеши (вход, смена, сброс, ссылки). */
export const PASSWORD_BCRYPT_ROUNDS = 12;

let dummyHash: Promise<string> | null = null;

/**
 * Сравнение пароля, которое ВСЕГДА стоит одинаково. Неизвестный номер, бот, удалённый
 * аккаунт отвечали мгновенно, а существующий — через ~250 мс bcrypt: по времени ответа
 * номера перебирались на существование (timing-оракул входа). Без хеша сравниваем с
 * фиктивным хешем той же стоимости и возвращаем false.
 */
export async function comparePasswordConstantTime(password: string, hash: string | null | undefined): Promise<boolean> {
  if (hash && hash.startsWith('$2')) return bcrypt.compare(password, hash);
  dummyHash ??= bcrypt.hash(randomBytes(24).toString('base64url'), PASSWORD_BCRYPT_ROUNDS);
  await bcrypt.compare(password, await dummyHash);
  return false;
}
