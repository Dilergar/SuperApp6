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
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  // Atomic INCR + first-hit PEXPIRE so a crash can't leave a key without a TTL
  // (which would otherwise pin a user as permanently rate-limited).
  private static readonly INCR_LUA = `
    local hits = redis.call('INCR', KEYS[1])
    if hits == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return {hits, redis.call('PTTL', KEYS[1])}
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

    // Already blocked? Keep rejecting until the block window expires.
    const blockPttl = await client.pttl(blockKey);
    if (blockPttl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    }

    const [hits, pttl] = (await client.eval(
      RedisThrottlerStorage.INCR_LUA,
      1,
      hitKey,
      ttl,
    )) as [number, number];

    let isBlocked = false;
    let timeToBlockExpire = 0;
    if (hits > limit) {
      isBlocked = true;
      await client.set(blockKey, '1', 'PX', blockDuration);
      timeToBlockExpire = Math.ceil(blockDuration / 1000);
    }

    return {
      totalHits: hits,
      timeToExpire: Math.ceil(pttl / 1000),
      isBlocked,
      timeToBlockExpire,
    };
  }
}
