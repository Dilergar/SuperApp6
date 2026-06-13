import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    if (!process.env.REDIS_URL) {
      // env validation forbids this in production; in dev it's a convenience fallback.
      this.logger.warn('REDIS_URL не задан — fallback на redis://localhost:6379 (только для разработки)');
    }
    this.client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
    });
    // Without this listener a dead Redis surfaces as unhandled 'error' events / opaque 500s.
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  /** Get value by key */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Set value with optional TTL in seconds */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /** Delete key */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Delete keys by pattern (SCAN — non-blocking; KEYS would freeze Redis on a big keyspace). */
  async delPattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /** Get JSON value */
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value ? JSON.parse(value) : null;
  }

  /** Set JSON value */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Publish event to channel */
  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  // ------------------------------------------------------------
  // Distributed lock (SET key val NX PX) — ensures a scheduled job runs on a
  // single instance in a multi-instance deployment.
  // ------------------------------------------------------------

  /** Try to acquire a lock. Returns an owner token iff this instance won it, else null. */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  /**
   * Release a lock ONLY if we still own it (compare-and-del, atomic via Lua). An unconditional DEL
   * would delete ANOTHER instance's lock when our TTL already expired and someone else took over.
   */
  async releaseLock(key: string, token: string): Promise<void> {
    await this.client.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      key,
      token,
    );
  }

  /**
   * Run `fn` only if this instance can acquire `key`. Returns the fn's result,
   * or null if the lock was already held (another instance is running it). The
   * TTL frees the lock even if the holder crashes. Intended for short,
   * infrequent jobs (crons) where ttlMs is comfortably larger than the job.
   * NB: if the job DOES outlive the TTL, another instance may start in parallel —
   * jobs must claim their work rows (status-guarded updateMany), not rely on the lock alone.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const token = await this.acquireLock(key, ttlMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.releaseLock(key, token);
    }
  }

  /**
   * Invalidate the cached `/users/me` profile for a user. Call after anything
   * the cached profile embeds changes (roles, default visibility, counts).
   */
  async invalidateUserProfile(userId: string): Promise<void> {
    await this.del(`user:${userId}:profile`);
  }

  /** Get the raw Redis client for advanced operations */
  getClient(): Redis {
    return this.client;
  }
}
