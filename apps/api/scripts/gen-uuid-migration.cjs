#!/usr/bin/env node
/**
 * Генератор миграции «id в нативный uuid» по схеме Prisma и живой базе.
 *
 * Берёт поля `String @db.Uuid` из schema.prisma, находит в базе колонки, которые ещё `text` /
 * `text[]`, и пишет SQL: сброс внешних ключей, которые касаются этих колонок → смена типа
 * `USING col::uuid` (одна ALTER TABLE на таблицу — одна перезапись) → умолчания PK
 * (`uuidv7()` / `gen_random_uuid()`) → возврат внешних ключей теми же определениями.
 * Индексы перестраивает сама смена типа. Не-UUID значение в колонке уронит миграцию целиком
 * (ALTER без USING-обхода) — так и задумано: чистить данные до, а не терять их молча.
 *
 * Запуск (DATABASE_URL из apps/api/.env): node scripts/gen-uuid-migration.cjs <каталог_миграции>
 */
const fs = require('node:fs');
const path = require('node:path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient, Prisma } = require('@prisma/client');

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: gen-uuid-migration.cjs <migration dir>');
  process.exit(1);
}
const q = (s) => `"${s.replace(/"/g, '""')}"`;

async function main() {
  const db = new PrismaClient();
  try {
    // Цели: (таблица, колонка, массив?, умолчание PK)
    const targets = new Map();
    for (const m of Prisma.dmmf.datamodel.models) {
      const table = m.dbName ?? m.name;
      for (const f of m.fields) {
        if (f.kind !== 'scalar' || f.type !== 'String' || f.nativeType?.[0] !== 'Uuid') continue;
        const col = f.dbName ?? f.name;
        let def = null;
        if (f.isId && f.default?.name === 'dbgenerated') def = f.default.args[0];
        targets.set(`${table}.${col}`, { table, col, list: f.isList, def });
      }
    }
    const cols = await db.$queryRawUnsafe(`
      SELECT c.table_name AS t, c.column_name AS c, c.data_type AS dt, c.udt_name AS udt, c.column_default AS d
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'`);
    const current = new Map(cols.map((r) => [`${r.t}.${r.c}`, r]));
    const todo = [...targets.values()].filter((t) => {
      const cur = current.get(`${t.table}.${t.col}`);
      if (!cur) throw new Error(`column ${t.table}.${t.col} is not in the database`);
      return cur.udt === 'text' || cur.udt === '_text' || cur.udt === 'varchar';
    });
    const todoSet = new Set(todo.map((t) => `${t.table}.${t.col}`));

    // Внешние ключи, касающиеся целевых колонок (с любой стороны)
    const fks = await db.$queryRawUnsafe(`
      SELECT con.conname AS name, cl.relname AS child, pl.relname AS parent, pg_get_constraintdef(con.oid) AS def,
        ARRAY(SELECT a.attname FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS ccols,
        ARRAY(SELECT a.attname FROM unnest(con.confkey) k JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k) AS pcols
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid AND NOT cl.relispartition
      JOIN pg_class pl ON pl.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      WHERE con.contype = 'f' AND con.conparentid = 0`);
    const touched = fks.filter((f) => f.ccols.some((c) => todoSet.has(`${f.child}.${c}`)) || f.pcols.some((c) => todoSet.has(`${f.parent}.${c}`)));
    // Каждый внешний ключ должен соединять одинаковые типы ПОСЛЕ миграции
    for (const f of touched) {
      for (let i = 0; i < f.ccols.length; i++) {
        const a = targets.has(`${f.child}.${f.ccols[i]}`);
        const b = targets.has(`${f.parent}.${f.pcols[i]}`);
        if (a !== b) throw new Error(`FK ${f.name}: ${f.child}.${f.ccols[i]} and ${f.parent}.${f.pcols[i]} would differ in type — mark both @db.Uuid or neither`);
      }
    }

    // Индексы с выражением по целевой колонке. Уникальность «NULL = пустая строка» через
    // COALESCE(col, ''::text) в uuid невыразима — переписывается на UNIQUE … NULLS NOT DISTINCT
    // (PG15+, тот же смысл). Любое другое выражение по целевой колонке — стоп, решать руками.
    const idx = await db.$queryRawUnsafe(`
      SELECT c.relname AS name, t.relname AS tbl, pg_get_indexdef(i.indexrelid) AS def, i.indisunique AS uniq
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      WHERE i.indexprs IS NOT NULL`);
    const idxDrop = [];
    const idxCreate = [];
    /** Список ключей индекса «( … )» после USING <метод> и предикат WHERE */
    const splitIndex = (def) => {
      const open = def.indexOf('(', def.indexOf(' USING '));
      let depth = 0;
      let close = open;
      for (let i = open; i < def.length; i++) {
        if (def[i] === '(') depth++;
        else if (def[i] === ')' && --depth === 0) {
          close = i;
          break;
        }
      }
      const keys = [];
      let buf = '';
      depth = 0;
      for (const ch of def.slice(open + 1, close)) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          keys.push(buf.trim());
          buf = '';
        } else buf += ch;
      }
      if (buf.trim()) keys.push(buf.trim());
      return { head: def.slice(0, open), keys, tail: def.slice(close + 1) };
    };
    for (const ix of idx) {
      const cols = todo.filter((t) => t.table === ix.tbl).map((t) => t.col);
      if (!cols.length) continue;
      const { head, keys, tail } = splitIndex(ix.def);
      const inExpr = (s) => cols.filter((c) => new RegExp(`\\b${c}\\b`).test(s));
      let rewritten = false;
      const newKeys = keys.map((k) => {
        if (/^\w+(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?$/i.test(k)) return k; // колонка как есть — тип сменит ALTER
        const hit = inExpr(k);
        if (!hit.length) return k;
        const m = k.match(/^COALESCE\((\w+), ''::text\)$/);
        if (m && ix.uniq && hit.includes(m[1])) {
          rewritten = true;
          return m[1];
        }
        throw new Error(`index ${ix.name}: ${hit.join(', ')} inside the expression "${k}" — rewrite it by hand: ${ix.def}`);
      });
      if (/::text/.test(tail) && inExpr(tail).some((c) => new RegExp(`\\b${c}\\)?::text`).test(tail))) {
        throw new Error(`index ${ix.name}: the predicate casts a converted column to text — rewrite it by hand: ${ix.def}`);
      }
      if (!rewritten) continue;
      idxDrop.push(`DROP INDEX ${q(ix.name)};`);
      const where = tail.trim();
      idxCreate.push(`${head}(${newKeys.join(', ')}) NULLS NOT DISTINCT${where ? ` ${where}` : ''};`);
    }

    const lines = [];
    lines.push('-- Архитектура данных: идентификаторы в нативный uuid (16 байт вместо 36-символьного TEXT) и');
    lines.push('-- UUIDv7 по умолчанию на стороне БАЗЫ (сырые INSERT тоже получают v7, часы одни).');
    lines.push('-- СГЕНЕРИРОВАНО apps/api/scripts/gen-uuid-migration.cjs по schema.prisma (@db.Uuid) и живой базе.');
    lines.push('-- Не-UUID значение в целевой колонке роняет миграцию целиком — данные чистятся ДО, не теряются молча.');
    lines.push("SET lock_timeout = '3s';");
    lines.push("SET statement_timeout = '600s';");
    lines.push('');
    lines.push(`-- 1. Внешние ключи, касающиеся колонок (${touched.length}) — сброс`);
    for (const f of touched) lines.push(`ALTER TABLE ${q(f.child)} DROP CONSTRAINT ${q(f.name)};`);
    if (idxDrop.length) {
      lines.push('-- Индексы с COALESCE(id, \'\') — снимаются и возвращаются как UNIQUE … NULLS NOT DISTINCT');
      lines.push(...idxDrop);
    }
    lines.push('');
    lines.push(`-- 2. Смена типа (${todo.length} колонок): одна ALTER TABLE на таблицу — одна перезапись`);
    const byTable = new Map();
    for (const t of todo) {
      if (!byTable.has(t.table)) byTable.set(t.table, []);
      byTable.get(t.table).push(t);
    }
    const restoreDefaults = [];
    for (const [table, list] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
      const clauses = [];
      for (const t of list) {
        const cur = current.get(`${t.table}.${t.col}`);
        if (cur.d && !t.def) {
          // Умолчание text[] (ARRAY[]::text[] / '{}') не приводится само — снять и вернуть в uuid[]
          clauses.push(`ALTER COLUMN ${q(t.col)} DROP DEFAULT`);
          restoreDefaults.push(`ALTER TABLE ${q(t.table)} ALTER COLUMN ${q(t.col)} SET DEFAULT ${cur.d.replace(/::text\[\]/g, '::uuid[]').replace(/::text\b/g, '::uuid')};`);
        }
        clauses.push(`ALTER COLUMN ${q(t.col)} TYPE ${t.list ? 'uuid[]' : 'uuid'} USING ${q(t.col)}::${t.list ? 'uuid[]' : 'uuid'}`);
        if (t.def) clauses.push(`ALTER COLUMN ${q(t.col)} SET DEFAULT ${t.def}`);
      }
      lines.push(`ALTER TABLE ${q(table)}\n  ${clauses.join(',\n  ')};`);
    }
    if (restoreDefaults.length) {
      lines.push('');
      lines.push('-- 3. Умолчания массивов — обратно, уже в uuid[]');
      lines.push(...restoreDefaults);
    }
    if (idxCreate.length) {
      lines.push('');
      lines.push('-- 3b. Уникальность «пустой родитель = один» — NULLS NOT DISTINCT вместо COALESCE(id, \'\')');
      lines.push(...idxCreate);
    }
    lines.push('');
    lines.push(`-- 4. Внешние ключи — обратно теми же определениями (${touched.length})`);
    for (const f of touched) lines.push(`ALTER TABLE ${q(f.child)} ADD CONSTRAINT ${q(f.name)} ${f.def};`);
    lines.push('');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'migration.sql'), lines.join('\n'));
    console.log(`columns: ${todo.length} in ${byTable.size} tables; foreign keys re-created: ${touched.length}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
