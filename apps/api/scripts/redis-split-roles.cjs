#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================
// Разделение Redis на две роли: уборка кэш-ключей из инстанса СОСТОЯНИЯ
// ============================================================
// После перехода с одного Redis на два (docs/data_architecture.md) ключи семейств роли `cache`
// (профили, роли, проверки прав, снимки тарифов, политика видимости, присутствие…) остаются в
// инстансе состояния: там их никто не вытеснит, а страж verify-lifecycle.cjs считает их
// лежащими не в своём инстансе. Кэш теряем без вреда — ключи удаляются, читатели пересоберут
// их из базы уже в инстансе кэша. Ключи роли `state` и чужие (`external`) не трогаются.
//
//   node apps/api/scripts/redis-split-roles.cjs            — сухой прогон: сколько и каких семейств
//   node apps/api/scripts/redis-split-roles.cjs --apply    — удалить
//
// Без REDIS_CACHE_URL (один инстанс) скрипту нечего делать — выход с пояснением.
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');
const { LIFECYCLE_POLICIES, LIFECYCLE_POLICY_IDS } = require('@superapp/shared');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const APPLY = process.argv.includes('--apply');
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

async function main() {
  const stateUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const cacheUrl = process.env.REDIS_CACHE_URL;
  if (!cacheUrl || cacheUrl === stateUrl) {
    console.log('REDIS_CACHE_URL is not set (or equals REDIS_URL): one instance — nothing to split');
    return;
  }
  const families = LIFECYCLE_POLICY_IDS.map((id) => LIFECYCLE_POLICIES[id]).filter((p) => p.store.kind === 'redis');
  const matchers = families.flatMap((p) => p.store.patterns.map((g) => ({ re: globRe(g), p })));
  const state = new Redis(stateUrl, { maxRetriesPerRequest: 3 });
  const byFamily = new Map();
  let removed = 0;
  let scanned = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await state.scan(cursor, 'COUNT', 1000);
      cursor = next;
      const doomed = [];
      for (const k of keys) {
        scanned++;
        const hit = matchers.find((m) => m.re.test(k));
        if (!hit || hit.p.store.role !== 'cache') continue;
        byFamily.set(hit.p.id, (byFamily.get(hit.p.id) ?? 0) + 1);
        doomed.push(k);
      }
      if (APPLY && doomed.length) removed += await state.unlink(...doomed);
    } while (cursor !== '0');
  } finally {
    state.disconnect();
  }
  console.log(`scanned ${scanned} key(s) in the state instance`);
  for (const [id, n] of [...byFamily].sort((a, b) => b[1] - a[1])) console.log(`  ${id}: ${n}`);
  console.log(APPLY ? `removed ${removed} cache key(s) from the state instance` : 'dry run — pass --apply to remove them');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
