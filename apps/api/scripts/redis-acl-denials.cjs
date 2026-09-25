#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================
// Отказы ACL приложения за прогон (docs/data_architecture.md, «ACL Redis»)
// ============================================================
// Права sa6_app — ПЕРЕЧЕНЬ команд (infra/redis/users.*.acl). Команда вне перечня отвечает NOPERM,
// а путь с `.catch()` (кэш, счётчики, метрики) проглотил бы отказ и деградировал молча — поэтому
// после сьюта читается ACL LOG обоих инстансов: любой отказ sa6_app (команда, ключ, канал, вход)
// роняет шаг. Исключение — канарейки verify-health.cjs: их соединение называется `sa6-acl-canary`,
// отказы там и есть проверка.
//
//   node apps/api/scripts/redis-acl-denials.cjs           — проверка (выход 1 при отказах)
//   node apps/api/scripts/redis-acl-denials.cjs --reset   — очистить журналы перед прогоном
//
// Читает журнал админом dev/CI: адрес из REDIS_URL / REDIS_CACHE_URL без учётных данных =
// пользователь `default` (в dev и CI без пароля; в проде он выключен — скрипт не для прода).
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const APP_USER = 'sa6_app';
const CANARY_CONNECTION = 'sa6-acl-canary';
const RESET = process.argv.includes('--reset');

/** Адрес инстанса без пользователя и пароля: вход `default` */
function adminUrl(raw) {
  const u = new URL(raw);
  u.username = '';
  u.password = '';
  return u.toString();
}

/** Запись ACL LOG — плоский массив «ключ, значение» → объект */
const entryOf = (flat) => {
  const o = {};
  for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};

async function main() {
  const stateUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const cacheUrl = process.env.REDIS_CACHE_URL;
  const targets = [['state', stateUrl]];
  if (cacheUrl && cacheUrl !== stateUrl) targets.push(['cache', cacheUrl]);

  let denials = 0;
  for (const [role, url] of targets) {
    const r = new Redis(adminUrl(url), { maxRetriesPerRequest: 2, lazyConnect: true });
    try {
      await r.connect();
      if (RESET) {
        await r.call('ACL', 'LOG', 'RESET');
        console.log(`  ↻ ${role}: ACL LOG очищен`);
        continue;
      }
      const log = /** @type {unknown[][]} */ (await r.call('ACL', 'LOG', '128')).map(entryOf);
      const own = log.filter((e) => e.username === APP_USER && !String(e['client-info'] ?? '').includes(`name=${CANARY_CONNECTION} `));
      for (const e of own) {
        denials++;
        console.error(`  ✗ ${role}: ${e.reason} «${e.object}» (${e.context}) ×${e.count}`);
      }
      if (!own.length) console.log(`  ✓ ${role}: отказов ${APP_USER} нет`);
    } finally {
      r.disconnect();
    }
  }
  if (denials) {
    console.error(`\nredis-acl-denials: ${denials} отказ(ов) — команда в коде, но не в перечне ACL (infra/redis/users.dev.acl + users.acl.template), либо код зовёт закрытое`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`redis-acl-denials: ${err.message}`);
  process.exit(2);
});
