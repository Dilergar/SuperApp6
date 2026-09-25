import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis, { type RedisOptions } from 'ioredis';

// ============================================================
// Redis в две роли (docs/data_architecture.md, реестр семейств — core/lifecycle)
// ============================================================
// СОСТОЯНИЕ (`REDIS_URL`: noeviction + AOF) — шина, локи, лимиты, эпохи, надгробия, окна
// детекций: потеря = ошибка корректности или безопасности. КЭШ (`REDIS_CACHE_URL`: allkeys-lfu,
// без персистентности) — только то, что пересобирается из базы: вытеснение под давлением памяти
// законно. В одном инстансе вытеснение кэша съело бы и состояние. Без `REDIS_CACHE_URL` (разработка)
// кэш живёт в том же клиенте. Роль ключа объявляет реестр `redis:<семейство>`; страж
// `verify-lifecycle.cjs` проверяет, что ключ лежит в инстансе своей роли.
//
// Путь запроса не ждёт Redis: после первого `ready` офлайн-очередь выключается — команда при
// разрыве падает сразу (кэш уходит в базу, лимит — в свою ветку отказа), а не висит до
// `connectTimeout` × попыток. Блокирующим потребителям — отдельное соединение `duplicateForBlocking`.

/** Доступ к Redis-кэшу. Только теряемое: читатель обязан пережить промах и ошибку (→ база). */
export class RedisCache {
  private static readonly logger = new Logger('RedisCache');

  constructor(private readonly c: Redis) {}

  get(key: string): Promise<string | null> {
    return this.c.get(key);
  }

  mget(keys: readonly string[]): Promise<(string | null)[]> {
    return keys.length ? this.c.mget(...keys) : Promise.resolve([]);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    // Кэш без срока — запрещён: вытеснение не заменяет TTL (allkeys-lfu держит «горячее» вечно)
    await this.c.set(key, value, 'EX', ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 3600);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.c.del(...keys);
  }

  /**
   * Сброс ПОСЛЕ коммита факта: DEL сейчас и ещё раз через 2 с. Второй DEL закрывает гонку
   * «заполнение/сброс» (Meta 2022): читатель, прочитавший базу ДО коммита, кладёт старое
   * значение ПОСЛЕ первого DEL — без второго оно жило бы весь TTL (роли, политика видимости,
   * «аккаунт жив»). Не бросает: сбой — громко в лог, значение доживёт свой TTL.
   */
  async forget(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    const del = () =>
      this.c.del(...keys).catch((err: Error) => {
        RedisCache.logger.warn(`cache invalidation of ${keys[0]}${keys.length > 1 ? ` (+${keys.length - 1})` : ''} failed: ${err.message}`);
        return 0;
      });
    await del();
    setTimeout(() => void del(), 2000).unref();
  }

  /** Удаление по шаблону (SCAN — не блокирует; KEYS заморозил бы Redis на большом пространстве ключей). */
  async delPattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.c.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.c.del(...keys);
    } while (cursor !== '0');
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Сырой клиент кэша — для pipeline/mget; ключи обязаны принадлежать семейству роли `cache`. */
  get client(): Redis {
    return this.c;
  }
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly cacheClient: Redis;
  /** Кэш (`REDIS_CACHE_URL`; без него — тот же инстанс, что состояние). */
  readonly cache: RedisCache;

  constructor() {
    if (!process.env.REDIS_URL) {
      // env-валидация запрещает это в production; в разработке — удобный запасной адрес
      this.logger.warn('REDIS_URL is not set — falling back to redis://localhost:6379 (development only)');
    }
    this.client = this.connect(process.env.REDIS_URL || 'redis://localhost:6379', 'state');
    const cacheUrl = process.env.REDIS_CACHE_URL;
    this.cacheClient = cacheUrl && cacheUrl !== process.env.REDIS_URL ? this.connect(cacheUrl, 'cache') : this.client;
    this.cache = new RedisCache(this.cacheClient);
  }

  private connect(url: string, role: 'state' | 'cache'): Redis {
    const client = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectionName: `superapp6-api:${role}`,
      // До первого `ready` команды буфера (бут) ждут соединения; после — падают сразу (см. шапку)
      enableOfflineQueue: true,
    });
    client.once('ready', () => {
      client.options.enableOfflineQueue = false;
    });
    // Без слушателя мёртвый Redis всплывает необработанными 'error' и безликими 500
    client.on('error', (err) => this.logger.error(`Redis (${role}) error: ${err.message}`));
    return client;
  }

  /** Бут дожидается обоих инстансов (не дольше 10 с): иначе первые запросы упали бы на пустом соединении. */
  async onModuleInit(): Promise<void> {
    const ready = (c: Redis, role: string) =>
      c.status === 'ready'
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              this.logger.error(`Redis (${role}) is not ready after 10s — requests will fail fast until it is`);
              resolve();
            }, 10_000);
            c.once('ready', () => {
              clearTimeout(t);
              resolve();
            });
          });
    await Promise.all([ready(this.client, 'state'), this.cacheClient === this.client ? null : ready(this.cacheClient, 'cache')]);
    await this.warnIfUnbounded(this.client, 'state');
    if (this.cacheClient !== this.client) await this.warnIfUnbounded(this.cacheClient, 'cache');
  }

  /**
   * `maxmemory` живёт не в файле конфига, а во флаге запуска (dev — docker-compose, прод — ≈ 50 %
   * RAM у состояния): забытый флаг = состояние растёт до OOM хоста, кэш ничего не вытесняет.
   * Громко на старте (INFO доступен пользователю приложения), а не молча в аварию.
   */
  private async warnIfUnbounded(client: Redis, role: 'state' | 'cache'): Promise<void> {
    try {
      const max = Number(/maxmemory:(\d+)/.exec(await client.info('memory'))?.[1] ?? 0);
      if (max === 0) this.logger.warn(`Redis (${role}) has no maxmemory limit — start it with --maxmemory (docs/data_architecture.md, Redis section)`);
    } catch (err) {
      this.logger.warn(`Redis (${role}) maxmemory check skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.client.quit(), this.cacheClient === this.client ? null : this.cacheClient.quit()]);
  }

  /** Кэш вынесен в отдельный инстанс (production). */
  get cacheIsSeparate(): boolean {
    return this.cacheClient !== this.client;
  }

  /** Клиент инстанса роли семейства реестра (`redis:<семейство>.role`); `external` — чужой Redis, null. */
  clientFor(role: 'state' | 'cache' | 'external'): Redis | null {
    if (role === 'state') return this.client;
    if (role === 'cache') return this.cacheClient;
    return null;
  }

  /** Различные инстансы (состояние, кэш — если отдельный): обходы «все ключи человека». */
  instances(): Redis[] {
    return this.cacheClient === this.client ? [this.client] : [this.client, this.cacheClient];
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
    await this.cache.forget(`user:${userId}:profile`);
  }

  /** Сырой клиент СОСТОЯНИЯ. Ключи роли `cache` — только через `cache`. */
  getClient(): Redis {
    return this.client;
  }

  /**
   * Отдельное соединение состояния для блокирующего чтения (XREADGROUP BLOCK): общий клиент
   * заблокировал бы все команды процесса. Офлайн-очередь включена явно (копия опций основного
   * клиента после `ready` несёт `false`), повторы без предела — цикл потребителя сам решает.
   */
  duplicateForBlocking(role: string): Redis {
    const c = this.client.duplicate({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      connectionName: `superapp6-api:state:${role}`,
    });
    c.on('error', (err) => this.logger.error(`Redis (${role}) error: ${err.message}`));
    return c;
  }
}
