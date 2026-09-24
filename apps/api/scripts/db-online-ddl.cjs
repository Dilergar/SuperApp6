#!/usr/bin/env node
/* eslint-disable */
// db-online-ddl — изменения горячих таблиц без простоя, ВНЕ `prisma migrate` (plan §9).
//
// Prisma исполняет файл миграции одной неявной транзакцией, а CONCURRENTLY / VALIDATE больших
// таблиц должны идти по одному, вне транзакции, с коротким lock_timeout и повторами: миграция,
// ждущая ACCESS EXCLUSIVE за долгой транзакцией, выстраивает за собой очередь ВСЕХ запросов
// к таблице (так роняли прод GitLab, Mattermost). Раннер:
//   - один оператор за раз на ОДНОМ соединении (SET lock_timeout действует на него);
//   - таймаут замка / дедлок → повтор с бэкоффом (5 попыток); CREATE INDEX CONCURRENTLY,
//     упавший посреди, оставляет невалидный индекс — он сносится (DROP … CONCURRENTLY) до повтора;
//   - `--partitioned-index` — индекс партиционированной таблицы онлайн: ON ONLY родителя
//     (невалидный) → CONCURRENTLY на каждом листе → ATTACH каждого к родительскому;
//   - `--dry` — только план.
//
// Использование:
//   node scripts/db-online-ddl.cjs <файл.sql> [--dry]
//   node scripts/db-online-ddl.cjs --partitioned-index <имя> <схема.родитель> "<(колонки) [WHERE …]>" [--dry]
// Файл: операторы через «;». Типичное: CREATE INDEX CONCURRENTLY …; ALTER TABLE … ADD CONSTRAINT
// … NOT VALID; ALTER TABLE … VALIDATE CONSTRAINT …; ALTER TABLE … ATTACH PARTITION ….
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LOCK_TIMEOUT = process.env.ONLINE_DDL_LOCK_TIMEOUT || '3s';
const ATTEMPTS = 5;
const IDENT = /^[a-z_][a-z0-9_]*$/i;

function url() {
  const base = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL (or DIRECT_URL) is required');
  // Одно соединение: SET lock_timeout и оператор обязаны идти через одну сессию
  return base + (base.includes('?') ? '&' : '?') + 'connection_limit=1';
}

const isLockProblem = (e) => /lock timeout|could not obtain lock|deadlock detected|55P03|40P01/i.test(String(e?.meta?.message ?? e?.message ?? e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitStatements(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function invalidIndexCleanup(db, stmt) {
  const m = stmt.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i);
  if (!m) return;
  const rows = await db.$queryRawUnsafe(`SELECT NOT i.indisvalid AS invalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, m[1]);
  if (rows[0]?.invalid) {
    console.log(`    ↺ невалидный индекс ${m[1]} после сбоя — снимаю перед повтором`);
    await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${m[1]}"`);
  }
}

async function runOne(db, stmt) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      await db.$executeRawUnsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
      await db.$executeRawUnsafe(`SET statement_timeout = 0`);
      await db.$executeRawUnsafe(stmt);
      console.log(`  ✓ ${(Date.now() - started) / 1000}s  ${stmt.slice(0, 110)}`);
      return;
    } catch (e) {
      if (!isLockProblem(e) || attempt >= ATTEMPTS) throw e;
      await invalidIndexCleanup(db, stmt);
      const wait = 500 * 2 ** attempt + Math.floor(Math.random() * 300);
      console.log(`  … замок не дался (попытка ${attempt}/${ATTEMPTS}) — повтор через ${wait} мс`);
      await sleep(wait);
    }
  }
}

async function partitionedIndex(db, name, parent, spec) {
  if (!IDENT.test(name)) throw new Error(`bad index name ${name}`);
  const [schema, table] = parent.split('.');
  if (!IDENT.test(schema ?? '') || !IDENT.test(table ?? '')) throw new Error(`parent must be schema.table, got ${parent}`);
  const leaves = await db.$queryRawUnsafe(
    `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace WHERE n.nspname = $1 AND p.relname = $2 ORDER BY c.relname`,
    schema,
    table,
  );
  // Родительский индекс ON ONLY — невалидный, пока к нему не прикреплён индекс каждого листа
  const steps = [`CREATE INDEX IF NOT EXISTS "${name}" ON ONLY "${schema}"."${table}" ${spec}`];
  for (const l of leaves) {
    const leafIdx = `${l.name}_${name}`.slice(0, 63);
    steps.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${leafIdx}" ON "${schema}"."${l.name}" ${spec}`);
    steps.push(`ALTER INDEX "${schema}"."${name}" ATTACH PARTITION "${schema}"."${leafIdx}"`);
  }
  return steps;
}

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: url() } } });
  try {
    let steps;
    const pi = args.indexOf('--partitioned-index');
    if (pi >= 0) {
      const [name, parent, spec] = args.slice(pi + 1, pi + 4);
      if (!name || !parent || !spec) throw new Error('usage: --partitioned-index <name> <schema.parent> "<(cols) [WHERE …]>"');
      steps = await partitionedIndex(db, name, parent, spec);
    } else {
      const file = args.find((a) => !a.startsWith('--'));
      if (!file) throw new Error('usage: db-online-ddl.cjs <file.sql> [--dry]');
      steps = splitStatements(fs.readFileSync(path.resolve(file), 'utf8'));
    }
    console.log(`${DRY ? 'План' : 'Исполнение'}: ${steps.length} оператор(ов), lock_timeout=${LOCK_TIMEOUT}`);
    for (const s of steps) {
      if (DRY) console.log(`  · ${s}`);
      else await runOne(db, s);
    }
    if (!DRY) console.log('Готово.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(String(e?.meta?.message ?? e?.message ?? e));
  process.exit(1);
});
