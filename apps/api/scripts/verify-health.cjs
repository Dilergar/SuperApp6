/* eslint-disable */
// ============================================================
// verify-health — эксплуатационный слой данных (core/lifecycle Э7, docs/data_architecture.md)
// ============================================================
//   - пробы `/health/live|ready` у корня: live без зависимостей, ready с разбивкой проверок
//     (детали — держателю METRICS_TOKEN; в dev без токена — открыто);
//   - сторожевые метрики БД (`lifecycle_db_*`, свежесть опроса), HTTP-гистограмма по ШАБЛОНУ
//     маршрута (ни одного id в метке), статус проверок готовности;
//   - пул приложения идёт через PgBouncer (режим транзакций, подготовленные выражения Prisma),
//     миграции и обслуживание — мимо него; потолки роли приложения и их снятие параметрами
//     запуска обслуживающего подключения;
//   - Redis в две роли: политики вытеснения инстансов, версия сервера = пин docker-compose.yml,
//     модули образа не загружены, ACL приложения — перечень команд (KEYS/CONFIG, новые команды
//     Redis 8, SORT и чужие каналы закрыты — проверка на срабатывание), кэш-ключ ложится в инстанс
//     кэша, а не состояния;
//   - env-валидация production требует REDIS_CACHE_URL ≠ REDIS_URL и DIRECT_URL (страж на
//     срабатывание: подсаженная неполная конфигурация отвергается).
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { BASE, SUITE, makeChecker, crash, call, login } = require('./_lib.cjs');

const { check, finish } = makeChecker();
const ROOT = BASE.replace(/\/api\/?$/, '');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function raw(p, headers = {}) {
  const res = await fetch(ROOT + p, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, text, json };
}

function metricValue(text, name, labels = '') {
  const re = new RegExp(`^${name}${labels ? `\\{${labels}\\}` : '(?:\\{[^}]*\\})?'} ([-0-9.e+]+)$`, 'm');
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

async function main() {
  // ---- 1. Пробы ----
  const live = await raw('/health/live');
  check('live: 200 без зависимостей', live.status === 200 && live.json?.status === 'ok', `${live.status} ${live.text.slice(0, 80)}`);
  const ready = await raw('/health/ready');
  const c = ready.json?.checks ?? {};
  check('ready: 200, итог ok|degraded', ready.status === 200 && ['ok', 'degraded'].includes(ready.json?.status), `${ready.status} ${ready.json?.status}`);
  check('ready: база и Redis-состояние — критичны и живы', c.database?.status === 'ok' && c.database?.critical === true && c.redis_state?.status === 'ok' && c.redis_state?.critical === true, JSON.stringify({ db: c.database, rs: c.redis_state }));
  check('ready: Redis-кэш — некритичен', c.redis_cache?.critical === false && ['ok', 'skipped'].includes(c.redis_cache?.status), JSON.stringify(c.redis_cache));
  check('ready: партиции журналов вперёд ≥ 1 (проверка движка через реестр)', c.partitions?.critical === false && (c.partitions?.detail?.minAhead ?? 0) >= 1, JSON.stringify(c.partitions));
  check('ready: бэкапы — проверка движка зарегистрирована (dev — skipped)', !!c.backups && c.backups.critical === false, JSON.stringify(c.backups));
  const prefixed = await call('GET', '/health/ready', null);
  check('пробы живут у корня, не под /api', prefixed.status === 404, String(prefixed.status));
  if (process.env.METRICS_TOKEN) {
    const bare = await raw('/health/ready', { Authorization: 'Bearer wrong-token' });
    check('ready: чужой токен — только итог, без разбивки', bare.json && !bare.json.checks, bare.text.slice(0, 120));
  } else {
    console.log('  · METRICS_TOKEN не задан — сокрытие разбивки проверяется только при заданном токене');
  }

  // ---- 2. Метрики ----
  const s1 = await login(SUITE.p1, SUITE.password);
  const me = await call('GET', '/users/me', s1.token);
  check('запрос с токеном (наполняет гистограмму маршрутом /api/users/me)', me.ok, String(me.status));
  const watch = await call('POST', '/lifecycle/dev/db-watch', s1.token, {});
  check('сторожевой опрос БД прошёл', watch.ok && watch.json?.data?.ok === true, `${watch.status} ${JSON.stringify(watch.json?.data ?? watch.json)}`);
  const auth = process.env.METRICS_TOKEN ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {};
  const m = await raw('/metrics', auth);
  check('/metrics отдаётся', m.status === 200, String(m.status));
  const now = Math.floor(Date.now() / 1000);
  const watchAt = metricValue(m.text, 'lifecycle_db_watch_last_success_seconds');
  check('свежесть опроса: lifecycle_db_watch_last_success_seconds ≤ минуты', watchAt !== null && now - watchAt <= 60, String(watchAt));
  const xid = metricValue(m.text, 'lifecycle_db_xid_age');
  const hit = metricValue(m.text, 'lifecycle_db_cache_hit_ratio');
  const maxConn = metricValue(m.text, 'lifecycle_db_max_connections');
  check('сигналы БД: возраст XID, доля кэша, max_connections', xid !== null && xid > 0 && hit !== null && hit > 0 && hit <= 1 && maxConn !== null && maxConn >= 100, `xid=${xid} hit=${hit} max=${maxConn}`);
  check('сигналы БД: потолок WAL слотов = max_slot_wal_keep_size (50 ГБ)', metricValue(m.text, 'lifecycle_db_slot_wal_cap_bytes') === 50 * 1024 ** 3, String(metricValue(m.text, 'lifecycle_db_slot_wal_cap_bytes')));
  check('статус проверок готовности в метриках', metricValue(m.text, 'health_check_status', 'check="database"') === 1, String(metricValue(m.text, 'health_check_status', 'check="database"')));
  const routes = [...m.text.matchAll(/^http_request_duration_seconds_count\{[^}]*route="([^"]*)"[^}]*\} /gm)].map((x) => x[1]);
  check('HTTP-гистограмма: маршрут /api/users/me учтён', routes.includes('/api/users/me'), routes.slice(0, 6).join(', '));
  check('HTTP-гистограмма: в метках маршрута нет ни одного id (только шаблоны)', routes.length > 0 && !routes.some((r) => UUID_RE.test(r)), routes.filter((r) => UUID_RE.test(r)).slice(0, 3).join(', '));

  // ---- 3. PgBouncer и потолки ролей ----
  const pooled = new PrismaClient();
  const directUrl = process.env.DIRECT_URL;
  const direct = new PrismaClient({ datasources: { db: { url: directUrl || process.env.DATABASE_URL } } });
  try {
    const pooledPort = new URL(process.env.DATABASE_URL).port;
    if (directUrl && directUrl !== process.env.DATABASE_URL) {
      check('DATABASE_URL — пулер (:6432), DIRECT_URL — база', pooledPort === '6432' && new URL(directUrl).port === '5432', `${pooledPort} / ${new URL(directUrl).port}`);
      const [a] = await pooled.$queryRaw`SELECT inet_client_addr()::text AS addr`;
      const [b] = await direct.$queryRaw`SELECT inet_client_addr()::text AS addr`;
      check('соединение пула приходит в базу от пулера, прямое — нет', !!a?.addr && a.addr !== b?.addr, `${a?.addr} vs ${b?.addr}`);
      // Подготовленные выражения через пулер: один и тот же запрос с разными параметрами много раз
      let okPrepared = true;
      for (let i = 0; i < 25; i++) {
        const [r] = await pooled.$queryRaw`SELECT ${i}::int + 1 AS n`;
        if (Number(r.n) !== i + 1) okPrepared = false;
      }
      check('подготовленные выражения Prisma живут через пулер (режим транзакций)', okPrepared);
      const txOk = await pooled.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', '1234ms', true)`;
        const [r] = await tx.$queryRaw`SELECT current_setting('statement_timeout') AS v`;
        return r.v;
      });
      check('SET LOCAL живёт внутри транзакции через пулер', txOk === '1234ms', String(txOk));
    } else {
      console.log('  · DIRECT_URL не задан или равен DATABASE_URL — проверки пулера пропущены (CI без PgBouncer)');
    }
    const [role] = await direct.$queryRaw`SELECT current_setting('statement_timeout') AS st, current_setting('transaction_timeout') AS tt, current_setting('idle_in_transaction_session_timeout') AS it`;
    check('потолки роли приложения: statement 30s, transaction 5min, idle-in-tx 60s (db-roles.sql)', role.st === '30s' && role.tt === '5min' && role.it === '1min', JSON.stringify(role));
    // Обслуживающее подключение: параметры запуска старше ALTER ROLE SET
    const u = new URL(directUrl || process.env.DATABASE_URL);
    u.searchParams.set('connection_limit', '1');
    u.searchParams.set('options', '-c statement_timeout=0 -c idle_in_transaction_session_timeout=600000 -c transaction_timeout=0');
    const maint = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    try {
      const [mr] = await maint.$queryRaw`SELECT current_setting('statement_timeout') AS st, current_setting('transaction_timeout') AS tt`;
      check('обслуживающее подключение снимает потолки роли (REINDEX, роллап)', mr.st === '0' && mr.tt === '0', JSON.stringify(mr));
    } finally {
      await maint.$disconnect();
    }
    const [fn] = await direct.$queryRaw`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('lifecycle_db_metrics', 'lifecycle_db_overview')`;
    check('функции монитора на месте', fn.n === 2, String(fn.n));
  } finally {
    await pooled.$disconnect();
    await direct.$disconnect();
  }

  // ---- 4. Redis в две роли ----
  const stateUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const cacheUrl = process.env.REDIS_CACHE_URL;
  const state = new Redis(stateUrl, { maxRetriesPerRequest: 2 });
  const cache = cacheUrl && cacheUrl !== stateUrl ? new Redis(cacheUrl, { maxRetriesPerRequest: 2 }) : null;
  try {
    const policyOf = async (r) => /maxmemory_policy:(\S+)/.exec(await r.info('memory'))?.[1];
    const aofOf = async (r) => /aof_enabled:(\d)/.exec(await r.info('persistence'))?.[1];
    if (cache) {
      check('состояние: noeviction + AOF', (await policyOf(state)) === 'noeviction' && (await aofOf(state)) === '1', `${await policyOf(state)} aof=${await aofOf(state)}`);
      check('кэш: allkeys-lfu без AOF', (await policyOf(cache)) === 'allkeys-lfu' && (await aofOf(cache)) === '0', `${await policyOf(cache)} aof=${await aofOf(cache)}`);
      // Кэш профиля и ролей пишется при чтении (/users/me выше) — в инстанс кэша, не состояния
      const scanAll = async (r, match) => {
        const out = [];
        let cur = '0';
        do {
          const [next, keys] = await r.scan(cur, 'MATCH', match, 'COUNT', 1000);
          cur = next;
          out.push(...keys);
        } while (cur !== '0');
        return out;
      };
      const inCache = await scanAll(cache, `user:${s1.id}:*`);
      const inState = await scanAll(state, `user:${s1.id}:*`);
      check('кэш-ключи человека (профиль, роли) — в инстансе кэша, не состояния', inCache.length > 0 && inState.length === 0, `cache=${inCache.join(',')} state=${inState.join(',')}`);
    } else {
      console.log('  · REDIS_CACHE_URL не задан — один инстанс, проверки ролей пропущены');
    }
    // Версия сервера = тег образа docker-compose.yml (единственный пин; CI берёт его оттуда же):
    // расхождение = контейнер не пересоздан после смены тега
    const pinned = /image:\s*redis:(\d+\.\d+\.\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docker-compose.yml'), 'utf8'))?.[1];
    for (const [role, r] of [['состояние', state], ...(cache ? [['кэш', cache]] : [])]) {
      const version = /redis_version:(\S+)/.exec(await r.info('server'))?.[1];
      check(`Redis ${role}: версия = пин docker-compose.yml (${pinned})`, !!pinned && version === pinned, String(version));
      // Модули образа (search, ReJSON, timeseries, bf) не грузятся — пустой tmpfs; vectorset встроен
      const modules = [...(await r.info('modules')).matchAll(/module:name=([^,]+)/g)].map((m) => m[1]);
      check(`Redis ${role}: модули образа не загружены`, modules.every((m) => m === 'vectorset'), modules.join(',') || '—');
    }
    const who = await state.call('ACL', 'WHOAMI').catch(() => null);
    if (who && who !== 'default') {
      // Канарейки — отдельным соединением с именем: их отказы ожидаемы, redis-acl-denials.cjs их
      // пропускает. Только неразрушающие команды: при сломанном ACL проба не должна ничего стереть.
      const canary = new Redis(stateUrl, { maxRetriesPerRequest: 2, connectionName: 'sa6-acl-canary' });
      try {
        const denied = async (...args) => canary.call(...args).then(() => 'allowed').catch((e) => String(e.message));
        const keys = await denied('KEYS', '*');
        check('ACL приложения: KEYS закрыт (срабатывание)', /NOPERM/.test(keys), keys.slice(0, 80));
        const cfg = await denied('CONFIG', 'GET', 'maxmemory');
        check('ACL приложения: CONFIG закрыт', /NOPERM/.test(cfg), cfg.slice(0, 80));
        // Перечень команд, а не категории: новые команды Redis 8 и модулей закрыты без отдельных строк
        const redis8 = [await denied('HGETEX', 'sa6:acl-canary', 'FIELDS', '1', 'f'), await denied('VCARD', 'sa6:acl-canary'), await denied('SORT', 'sa6:acl-canary')];
        check('ACL приложения: новые команды Redis 8 (HGETEX, VCARD) и SORT закрыты', redis8.every((m) => /NOPERM/.test(m)), redis8.map((m) => m.slice(0, 40)).join(' | '));
        const channels = [await denied('PUBLISH', 'sa6-acl-canary', 'x'), await denied('SPUBLISH', 'sa6-acl-canary', 'x')];
        check('ACL приложения: каналы вне socket.io#* закрыты', channels.every((m) => /NOPERM/.test(m)), channels.map((m) => m.slice(0, 40)).join(' | '));
      } finally {
        canary.disconnect();
      }
      const scan = await state.scan('0', 'COUNT', 10).then(() => 'ok').catch((e) => String(e.message));
      check('ACL приложения: SCAN и INFO открыты', scan === 'ok', scan);
    } else {
      console.log('  · Redis без пользователя приложения (default) — проверки ACL пропущены');
    }
  } finally {
    state.disconnect();
    cache?.disconnect();
  }

  // ---- 5. env-валидация production (страж на срабатывание) ----
  const { validateEnv } = require(path.join(__dirname, '..', 'dist', 'shared', 'config', 'env.validation.js'));
  const saved = { ...process.env };
  const probe = (patch) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved, { NODE_ENV: 'production' }, patch);
    try {
      validateEnv();
      return '';
    } catch (e) {
      return String(e.message);
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  const noCache = probe({ REDIS_CACHE_URL: '' });
  check('production без REDIS_CACHE_URL отвергается', /REDIS_CACHE_URL: is required in production/.test(noCache), noCache.split('\n').find((l) => l.includes('REDIS_CACHE_URL')) ?? '');
  const sameCache = probe({ REDIS_CACHE_URL: process.env.REDIS_URL || 'redis://localhost:6379', REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379' });
  check('production с кэшем в инстансе состояния отвергается', /REDIS_CACHE_URL: must point to a separate instance/.test(sameCache), sameCache.split('\n').find((l) => l.includes('REDIS_CACHE_URL')) ?? '');
  const noDirect = probe({ DIRECT_URL: '' });
  check('production без DIRECT_URL отвергается', /DIRECT_URL: is required in production/.test(noDirect), noDirect.split('\n').find((l) => l.includes('DIRECT_URL')) ?? '');

  finish();
}

main().catch(crash);
