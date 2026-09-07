import type { RedisService } from '../../shared/redis/redis.service';

/**
 * Скользящее окно из двух корзин (копия модели бюджетов core/verify): бюджет продюсера,
 * burst guard push, суточные потолки SMS. Best-effort: недоступный Redis не должен
 * ронять фанаут — вызывающий ловит и трактует как «предел не достигнут».
 */
function windowOf(prefix: string, windowSec: number) {
  const nowSec = Date.now() / 1000;
  const bucket = Math.floor(nowSec / windowSec);
  return {
    curKey: `${prefix}:${bucket}`,
    prevKey: `${prefix}:${bucket - 1}`,
    elapsed: (nowSec % windowSec) / windowSec,
  };
}

/** Прочитать окно БЕЗ инкремента (проверка предела). */
export async function slidingPeek(redis: RedisService, prefix: string, windowSec: number): Promise<number> {
  const client = redis.getClient();
  const { curKey, prevKey, elapsed } = windowOf(prefix, windowSec);
  const [current, previous] = await Promise.all([client.get(curKey), client.get(prevKey)]);
  return (Number(current) || 0) + (Number(previous) || 0) * (1 - elapsed);
}

/** Записать состоявшееся событие в окно. */
export async function slidingRecord(redis: RedisService, prefix: string, windowSec: number, by = 1): Promise<void> {
  const client = redis.getClient();
  const { curKey } = windowOf(prefix, windowSec);
  await client.multi().incrby(curKey, by).expire(curKey, windowSec * 2).exec();
}

/** Счётчик с TTL: сколько раз ключ дёрнули за окно (троттлинг типа на пару адресат×ключ). */
export async function countInWindow(redis: RedisService, key: string, windowSec: number): Promise<number> {
  const client = redis.getClient();
  const res = await client.multi().incr(key).expire(key, windowSec, 'NX').exec();
  const n = res?.[0]?.[1];
  return typeof n === 'number' ? n : Number(n) || 1;
}
