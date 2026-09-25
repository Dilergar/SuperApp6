#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================
// Учение восстановления: сверки восстановленной копии + подписанный отчёт в движок
// ============================================================
// Рунбук — docs/operations_backup_dr.md. Прод: infra/pgbackrest/restore-drill.sh поднимает
// scratch-кластер из последнего бэкапа (или на случайную точку — PITR) и зовёт этот скрипт с
// DRILL_RESTORED_URL. Разработка: `--dev-clone` снимает логическую копию dev-базы в
// `superapp6_drill` того же контейнера (pg_dump | pg_restore) — учение сверок и отчёта целиком.
//
// Сверки (LIFECYCLE_RESTORE_CHECKS):
//   row_counts     — каждая таблица источника есть в копии; крупная (≥ 1000 строк) не пуста
//                    наполовину (усечённый или пустой restore — провал);
//   ledger_sum     — Σ балансов по каждой валюте = 0 (двойная запись пережила восстановление);
//   audit_merkle   — дайджесты журнала безопасности копии совпадают с источником (корень
//                    Меркла, подпись), а число событий в диапазоне каждого = его count;
//   erasure_replay — журнал стираний копии — префикс журнала источника (реплей после
//                    восстановления применит недостающее, ничего не потеряно).
//
//   node apps/api/scripts/lifecycle-restore-drill.cjs --dev-clone [--report] [--keep]
//   DRILL_RESTORED_URL=… node apps/api/scripts/lifecycle-restore-drill.cjs --report --kind=restore_drill --repo=repo1
//
// Отчёт: POST <SA6_API_BASE>/lifecycle/ops/backups/report, Bearer LIFECYCLE_OPS_TOKEN +
// X-Lifecycle-Signature (HMAC тела); без токена — только разработка (сервер в проде ответит 404).
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const DEV_CLONE = flag('dev-clone');
const KIND = arg('kind', 'restore_drill');
const REPO = arg('repo', DEV_CLONE ? 'dev' : 'repo1');
const DRILL_DB = 'superapp6_drill';
const API = process.env.SA6_API_BASE || process.env.API_URL || 'http://localhost:3001/api';
const MIN_ROWS = 1000;

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.searchParams.set('connection_limit', '2');
  return u.toString();
}

/** dev: логическая копия dev-базы в соседнюю базу того же контейнера. */
function devClone(sourceUrl) {
  const u = new URL(sourceUrl);
  const db = u.pathname.slice(1);
  const user = decodeURIComponent(u.username);
  const sh = (cmd) => execFileSync('docker', ['exec', 'superapp6-db', 'sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
  sh(`dropdb -U ${user} --if-exists --force ${DRILL_DB} && createdb -U ${user} ${DRILL_DB}`);
  // --no-owner: копия — для сверок, не для работы; владельцы кластера те же
  sh(`pg_dump -U ${user} -Fc ${db} | pg_restore -U ${user} -d ${DRILL_DB} --no-owner --exit-on-error`);
  return withDb(sourceUrl, DRILL_DB);
}

function devDrop(sourceUrl) {
  const user = decodeURIComponent(new URL(sourceUrl).username);
  execFileSync('docker', ['exec', 'superapp6-db', 'sh', '-c', `dropdb -U ${user} --if-exists --force ${DRILL_DB}`], { stdio: 'ignore' });
}

async function tables(db) {
  // Родители и обычные таблицы (листья партиций считаются через родителя)
  return db.$queryRawUnsafe(`
    SELECT n.nspname || '.' || c.relname AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'lc_probe')
       AND n.nspname NOT LIKE 'pg_temp%'`);
}

async function count(db, t) {
  const [schema, table] = t.split('.');
  const [r] = await db.$queryRawUnsafe(`SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`);
  return Number(r.n);
}

async function checkRowCounts(src, dst) {
  const srcTables = (await tables(src)).map((r) => r.t);
  const dstSet = new Set((await tables(dst)).map((r) => r.t));
  const missing = srcTables.filter((t) => !dstSet.has(t));
  const thin = [];
  for (const t of srcTables) {
    if (!dstSet.has(t)) continue;
    const s = await count(src, t);
    if (s < MIN_ROWS) continue;
    const d = await count(dst, t);
    if (d < s / 2) thin.push(`${t} ${d}/${s}`);
  }
  if (missing.length) console.log(`  missing tables: ${missing.slice(0, 10).join(', ')}`);
  if (thin.length) console.log(`  thin tables: ${thin.slice(0, 10).join(', ')}`);
  return missing.length === 0 && thin.length === 0;
}

async function checkLedger(dst) {
  const bad = await dst.$queryRawUnsafe(`SELECT currency_id::text AS c, sum(balance)::text AS s FROM accounts GROUP BY currency_id HAVING sum(balance) <> 0`);
  if (bad.length) console.log(`  ledger imbalance: ${bad.map((b) => `${b.c}=${b.s}`).join(', ')}`);
  return bad.length === 0;
}

async function checkAudit(src, dst) {
  const q = `SELECT xact_from::text AS f, xact_to::text AS t, count, encode(merkle_root, 'hex') AS root, encode(signature, 'hex') AS sig
               FROM security_digests ORDER BY xact_from DESC LIMIT 50`;
  const dstDigests = await dst.$queryRawUnsafe(q);
  const srcByFrom = new Map((await src.$queryRawUnsafe(q.replace('LIMIT 50', 'LIMIT 500'))).map((d) => [d.f, d]));
  let ok = true;
  for (const d of dstDigests) {
    const s = srcByFrom.get(d.f);
    if (s && (s.root !== d.root || s.sig !== d.sig)) {
      console.log(`  digest ${d.f}: root/signature differ from the source`);
      ok = false;
    }
    const [c] = await dst.$queryRawUnsafe(`SELECT count(*)::int AS n FROM security_events WHERE xact::text::bigint >= $1::bigint AND xact::text::bigint < $2::bigint`, d.f, d.t);
    if (c.n !== d.count) {
      console.log(`  digest ${d.f}: ${c.n} event(s) in the copy, digest signed ${d.count}`);
      ok = false;
    }
  }
  return ok;
}

async function checkErasureJournal(src, dst) {
  const [d] = await dst.$queryRawUnsafe(`SELECT COALESCE(max(id), 0)::text AS max, count(*)::int AS n FROM lifecycle_erasure_journal`);
  const [s] = await src.$queryRawUnsafe(`SELECT count(*)::int AS n FROM lifecycle_erasure_journal WHERE id <= $1::bigint`, d.max);
  // Префикс: в источнике до той же границы ровно столько же строк (ничего не выпало из копии)
  const ok = s.n === d.n;
  if (!ok) console.log(`  erasure journal: copy ${d.n} row(s) up to id ${d.max}, source ${s.n}`);
  return ok;
}

async function report(body) {
  const raw = JSON.stringify(body);
  const token = process.env.LIFECYCLE_OPS_TOKEN || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', token).update(`${t}.`).update(raw).digest('hex');
    headers.Authorization = `Bearer ${token}`;
    headers['X-Lifecycle-Signature'] = `t=${t},v1=${sig}`;
  }
  const res = await fetch(`${API}/lifecycle/ops/backups/report`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  if (!res.ok) throw new Error(`report rejected: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).data;
}

async function main() {
  const sourceUrl = process.env.DRILL_SOURCE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DRILL_SOURCE_URL / DIRECT_URL is required');
  const startedAt = new Date();
  let restoredUrl = process.env.DRILL_RESTORED_URL;
  if (DEV_CLONE) {
    console.log(`cloning the dev database into ${DRILL_DB} …`);
    restoredUrl = devClone(sourceUrl);
  }
  if (!restoredUrl) throw new Error('DRILL_RESTORED_URL is required (or --dev-clone in development)');
  const src = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
  const dst = new PrismaClient({ datasources: { db: { url: restoredUrl } } });
  const checks = {};
  let errorCode;
  try {
    checks.row_counts = await checkRowCounts(src, dst);
    checks.ledger_sum = await checkLedger(dst);
    checks.audit_merkle = await checkAudit(src, dst);
    checks.erasure_replay = await checkErasureJournal(src, dst);
  } catch (err) {
    errorCode = 'drill.check_crashed';
    console.error(err);
  } finally {
    await src.$disconnect();
    await dst.$disconnect();
    if (DEV_CLONE && !flag('keep')) devDrop(sourceUrl);
  }
  const finishedAt = new Date();
  const ok = !errorCode && Object.keys(checks).length === 4 && Object.values(checks).every(Boolean);
  console.log(`checks: ${JSON.stringify(checks)} → ${ok ? 'OK' : 'FAILED'} in ${Math.round((finishedAt - startedAt) / 1000)}s`);
  if (flag('report')) {
    const r = await report({
      kind: KIND,
      repo: REPO,
      status: ok ? 'ok' : 'failed',
      externalId: `${KIND}-${startedAt.toISOString()}`,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      details: { checks, rtoSeconds: Math.round((finishedAt - startedAt) / 1000), ...(errorCode ? { errorCode } : {}) },
    });
    console.log(`reported: ${JSON.stringify(r)}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
