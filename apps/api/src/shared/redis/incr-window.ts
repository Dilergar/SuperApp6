import type Redis from 'ioredis';

/**
 * Счётчик окна одним MULTI: INCRBY + EXPIRE NX. Раздельные INCR и EXPIRE (EXPIRE только при n = 1)
 * при сбое между ними оставляли ключ без срока — вечный счётчик: вечный лимит, вечная блокировка,
 * детекция, не забывающая прошлое. NX не продлевает уже идущее окно (Redis ≥ 7).
 */
export async function incrWindow(client: Redis, key: string, windowSec: number, by = 1): Promise<number> {
  const res = await client.multi().incrby(key, by).expire(key, windowSec, 'NX').exec();
  const [err, value] = res?.[0] ?? [new Error('redis multi returned nothing'), null];
  if (err) throw err;
  return Number(value);
}
