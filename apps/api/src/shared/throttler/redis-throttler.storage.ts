import type { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../redis/redis.service';

// @nestjs/throttler doesn't re-export this record type from its package root,
// so we mirror its shape here. `implements ThrottlerStorage` below verifies
// structural compatibility with the real interface at compile time.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed ThrottlerStorage so rate-limit counters are SHARED across all
 * API instances. The default storage is in-memory and per-process, which would
 * make a "5 requests / 15 min" limit actually allow 5×N across N instances (and
 * reset on every redeploy).
 *
 * Units mirror @nestjs/throttler's default storage: `ttl` / `blockDuration`
 * arrive in milliseconds; `timeToExpire` / `timeToBlockExpire` are seconds.
 *
 * Один Lua-вызов на троттлер (перф-ревью 2026-07-18): раньше PTTL + EVAL (+SET при
 * блоке) = 2–3 round-trip'а × 3 именованных троттлера = 6+ Redis-опов на КАЖДЫЙ
 * HTTP-запрос платформы. Теперь блок-чек, инкремент с первым PEXPIRE и постановка
 * блока — атомарно в одном скрипте: 3 опа на запрос (по одному на троттлер).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  // KEYS[1] = hit counter, KEYS[2] = block marker.
  // ARGV[1] = ttl ms, ARGV[2] = limit, ARGV[3] = blockDuration ms.
  // Returns {-1, blockPttl} when already blocked, else {hits, pttl, blockedFlag, blockPx}.
  // Atomic INCR + first-hit PEXPIRE so a crash can't leave a key without a TTL
  // (which would otherwise pin a user as permanently rate-limited).
  private static readonly CHECK_LUA = `
    local blockPttl = redis.call('PTTL', KEYS[2])
    if blockPttl > 0 then
      return {-1, blockPttl}
    end
    local hits = redis.call('INCR', KEYS[1])
    if hits == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    local pttl = redis.call('PTTL', KEYS[1])
    if hits > tonumber(ARGV[2]) then
      redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
      return {hits, pttl, 1, tonumber(ARGV[3])}
    end
    return {hits, pttl, 0, 0}
  `;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redis.getClient();
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    const res = (await client.eval(
      RedisThrottlerStorage.CHECK_LUA,
      2,
      hitKey,
      blockKey,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number?, number?];

    // Already blocked — keep rejecting until the block window expires.
    if (res[0] === -1) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(Number(res[1]) / 1000),
      };
    }

    const [hits, pttl, blockedFlag, blockPx] = res;
    const isBlocked = Number(blockedFlag) === 1;
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(pttl / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(Number(blockPx) / 1000) : 0,
    };
  }
}
