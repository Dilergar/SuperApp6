#!/usr/bin/env node
/**
 * Аудит сырого SQL после перевода id в нативный uuid. Prisma шлёт строковый параметр как
 * `text`, поэтому сравнение `uuid_col = ${id}` падает («operator does not exist: uuid = text»),
 * `ANY(${ids}::text[])` против uuid-колонки — тоже, а вставка `${id}` в uuid-колонку — «column is
 * of type uuid but expression is of type text».
 *
 * Скрипт разбирает каждый шаблон `$queryRaw` / `$executeRaw` / `Prisma.sql` / `*Unsafe`:
 * алиасы FROM / JOIN / UPDATE / DELETE / INSERT INTO → таблица, тип колонки — по DMMF КОНКРЕТНОЙ
 * таблицы (`id` в users — uuid, в platform_policy — text). Находки:
 *   - uuid-колонка ⋈ параметр без `::uuid` (и `ANY(…::text[])` у uuid-колонки);
 *   - вставка параметра в uuid-колонку без `::uuid`;
 *   - text-ссылка (`ref_id`, `subject_id`) ⋈ uuid-колонка без приведения.
 * Эвристика, а не парсер SQL: 0 находок — цель; спорное — на ревью.
 * Запуск: node scripts/audit-raw-sql-uuid.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const { Prisma } = require('@prisma/client');

// `--dir scripts` — те же правила для сьютов и скриптов обслуживания (.cjs)
const dirArg = process.argv.indexOf('--dir');
const SRC = dirArg > 0 ? path.resolve(path.join(__dirname, '..'), process.argv[dirArg + 1]) : path.join(__dirname, '..', 'src');
/** таблица → колонка → 'uuid' | 'text' (только id-подобные и все uuid) */
const TYPES = new Map();
for (const m of Prisma.dmmf.datamodel.models) {
  const t = new Map();
  for (const f of m.fields) {
    if (f.kind !== 'scalar') continue;
    const col = f.dbName ?? f.name;
    if (f.nativeType?.[0] === 'Uuid') t.set(col, 'uuid');
    else if (f.type === 'String') t.set(col, 'text');
  }
  TYPES.set(m.dbName ?? m.name, t);
}
// Сырые таблицы вне Prisma (типы колонок id в миграциях — uuid)
TYPES.set('events', new Map([['user_id', 'uuid'], ['workspace_id', 'uuid'], ['session_id', 'uuid'], ['anonymous_id', 'uuid'], ['event_id', 'uuid'], ['device_id', 'uuid'], ['login_sid', 'uuid'], ['ref_id', 'uuid']]));
// Типы — по information_schema (idem.keys.api_key_id — text, response_id — bigint; responses.scope_id — uuid)
TYPES.set('keys', new Map([['user_id', 'uuid'], ['workspace_id', 'uuid'], ['api_key_id', 'text'], ['resource_id', 'text'], ['response_id', 'bigint']]));
TYPES.set('responses', new Map([['id', 'bigint'], ['scope_id', 'uuid']]));
TYPES.set('outbox', new Map([['id', 'bigint']]));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|cjs)$/.test(e.name) && !e.name.startsWith('audit-raw-sql')) out.push(p);
  }
  return out;
}

/** Тело шаблона и его границы в файле (для --fix). Вложенные `${…}` с шаблонами внутри учитываются. */
function sqlChunks(src) {
  const out = [];
  // Дженерик с вложенностью (`$queryRaw<Array<{ id: string }>>`) — до трёх уровней угловых скобок
  const tagRe = /(\$queryRaw|\$executeRaw|Prisma\.sql|\bsql)\s*(<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*`/g;
  let m;
  while ((m = tagRe.exec(src))) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (depth === 0 && ch === '`') break;
      if (src.startsWith('${', i)) {
        depth++;
        i++;
        continue;
      }
      if (depth > 0 && ch === '{') depth++;
      if (depth > 0 && ch === '}') depth--;
    }
    out.push({ at: m.index, start, end: i, sql: src.slice(start, i) });
  }
  const unsafeRe = /\$(queryRawUnsafe|executeRawUnsafe)\s*(<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(\s*`/g;
  while ((m = unsafeRe.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('`', start);
    out.push({ at: m.index, start, end, sql: src.slice(start, end), unsafe: true });
  }
  return out;
}
const FIX = process.argv.includes('--fix');

const KEYWORDS = new Set(['where', 'on', 'join', 'left', 'right', 'inner', 'set', 'and', 'or', 'group', 'order', 'limit', 'using', 'returning', 'values', 'as', 'lateral', 'cross', 'full', 'union', 'select', 'from', 'having', 'window', 'for', 'natural']);
/** alias → table и список таблиц чанка */
function aliases(flat) {
  const map = new Map();
  const tables = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE FROM)\s+(?:ONLY\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?(?:\s+(?:AS\s+)?"?(\w+)"?)?/gi;
  for (const x of flat.matchAll(re)) {
    const table = x[2];
    if (!TYPES.has(table)) continue;
    tables.push(table);
    map.set(table, table);
    const al = x[3];
    if (al && !KEYWORDS.has(al.toLowerCase())) map.set(al, table);
  }
  return { map, tables };
}
/** Тип колонки по всей схеме: одинаков во всех таблицах — он, иначе 'ambiguous' (для фрагментов без FROM). */
const GLOBAL = new Map();
for (const t of TYPES.values()) for (const [c, ty] of t) GLOBAL.set(c, GLOBAL.has(c) && GLOBAL.get(c) !== ty ? 'ambiguous' : ty);
function typeOf(alias, col, ctx) {
  if (alias) {
    const t = ctx.map.get(alias);
    if (t) return TYPES.get(t).get(col);
    // Алиас фрагмента (`${col}."space_id"`, таблица подставляется снаружи) — тип по всей схеме
    return ctx.tables.length ? undefined : GLOBAL.get(col);
  }
  if (!ctx.tables.length) return GLOBAL.get(col);
  const found = new Set(ctx.tables.map((t) => TYPES.get(t).get(col)).filter(Boolean));
  return found.size === 1 ? [...found][0] : found.size > 1 ? 'ambiguous' : undefined;
}

const findings = [];
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
for (const file of walk(SRC)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!/\$queryRaw|\$executeRaw|Prisma\.sql|\bsql`/.test(src)) continue;
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  // Переменные-фрагменты, УЖЕ приведённые к uuid (`const ids = Prisma.sql\`${granted}::uuid[]\``)
  const preCast = new Set([...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*Prisma\.sql`\$\{[^}]*\}::uuid(?:\[\])?`/g)].map((m) => m[1]));
  // С конца файла: правки не сдвигают границы ещё не обработанных шаблонов
  const chunks = sqlChunks(src).sort((a, b) => b.start - a.start);
  let dirty = false;
  for (const ch of chunks) {
    const { at, unsafe } = ch;
    let sql = ch.sql;
    const ctx = aliases(sql.replace(/\s+/g, ' '));
    const report = (kind, snippet) => findings.push({ file: rel, line: lineOf(src, at), kind, snippet: snippet.replace(/\s+/g, ' ').slice(0, 160) });
    const param = unsafe ? '\\$\\d+' : '\\$\\{[^}]*\\}';
    const col = '(?:"?(\\w+)"?\\.)?"?(\\w+)"?';
    const edits = []; // [index, length, replacement]
    // (1) колонка ОП параметр
    for (const x of sql.matchAll(new RegExp(`${col}(\\s*(?:=|<>|!=|IN\\s*\\(|=\\s*ANY\\s*\\(|<=|>=|<|>)\\s*)(${param})(::\\w+(\\[\\])?)?`, 'gi'))) {
      const ty = typeOf(x[1], x[2], ctx);
      if (ty !== 'uuid' && ty !== 'ambiguous') continue;
      if (/::uuid/i.test(x[5] ?? '')) continue;
      // Явное приведение к другому типу (`${after}::bigint`) — автор знает тип колонки
      if (x[5] && !/^::text(\[\])?$/i.test(x[5])) continue;
      if (preCast.has((x[4].match(/^\$\{\s*(\w+)\s*\}$/) ?? [])[1])) continue;
      if (ty === 'ambiguous') {
        report('ambiguous column = param (check type)', x[0]);
        continue;
      }
      if (/IN\s*\($/i.test(x[3].trim()) && /Prisma\.join/.test(x[4])) {
        report('uuid-col IN (Prisma.join) — rewrite as = ANY(${ids}::uuid[])', x[0]);
        continue;
      }
      report('uuid-col = param without ::uuid', x[0]);
      const isArray = /ANY\s*\(/i.test(x[3]) || /\[\]$/.test(x[5] ?? '');
      const castAt = x.index + x[0].length - (x[5]?.length ?? 0);
      edits.push([castAt, x[5]?.length ?? 0, isArray ? '::uuid[]' : '::uuid']);
    }
    // (1b) параметр ОП колонка
    for (const x of sql.matchAll(new RegExp(`(${param})(::\\w+(\\[\\])?)?(\\s*(?:=|<>)\\s*)${col}`, 'gi'))) {
      const ty = typeOf(x[5], x[6], ctx);
      if (ty === 'uuid' && !/::uuid/i.test(x[2] ?? '')) {
        report('param = uuid-col without ::uuid', x[0]);
        edits.push([x.index + x[1].length, x[2]?.length ?? 0, '::uuid']);
      }
    }
    // (1c) параметр = ANY(uuid[]-колонка) и array_append/remove(uuid[]-колонка, параметр)
    for (const x of sql.matchAll(new RegExp(`(${param})(::\\w+(\\[\\])?)?(\\s*=\\s*ANY\\s*\\(\\s*)${col}\\s*\\)`, 'gi'))) {
      if (typeOf(x[5], x[6], ctx) === 'uuid' && !/::uuid/i.test(x[2] ?? '')) {
        report('param = ANY(uuid[] col) without ::uuid', x[0]);
        edits.push([x.index + x[1].length, x[2]?.length ?? 0, '::uuid']);
      }
    }
    for (const x of sql.matchAll(new RegExp(`array_(?:append|prepend|remove)\\(\\s*${col}\\s*,\\s*(${param})(::\\w+)?\\s*\\)`, 'gi'))) {
      if (typeOf(x[1], x[2], ctx) === 'uuid' && !/::uuid/i.test(x[4] ?? '')) {
        report('array op on uuid[] col with a non-uuid param', x[0]);
        const at = x.index + x[0].lastIndexOf(x[3]) + x[3].length;
        edits.push([at, x[4]?.length ?? 0, '::uuid']);
      }
    }
    // (2) INSERT: параметр в uuid-колонку (все кортежи VALUES)
    const ins = sql.match(/INSERT INTO\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*/i);
    if (ins && TYPES.has(ins[1])) {
      const cols = ins[2].split(',').map((s) => s.trim().replace(/"/g, ''));
      let i = ins.index + ins[0].length;
      while (sql[i] === '(') {
        // один кортеж: значения верхнего уровня
        let depth = 0;
        let valStart = i + 1;
        let idx = 0;
        let j = i;
        for (; j < sql.length; j++) {
          const c = sql[j];
          if (sql.startsWith('${', j)) {
            let d = 1;
            j += 2;
            while (j < sql.length && d > 0) {
              if (sql[j] === '{') d++;
              else if (sql[j] === '}') d--;
              j++;
            }
            j--;
            continue;
          }
          if (c === '(') depth++;
          else if (c === ')') depth--;
          if ((c === ',' && depth === 1) || (c === ')' && depth === 0)) {
            const raw = sql.slice(valStart, j);
            const v = raw.trim();
            const colName = cols[idx];
            const pm = v.match(new RegExp(`^(${param})(::text(\\[\\])?)?$`));
            if (colName && TYPES.get(ins[1]).get(colName) === 'uuid' && pm) {
              report(`INSERT ${ins[1]}.${colName} ← param without ::uuid`, `${colName} ← ${v}`);
              const at = valStart + raw.indexOf(v) + pm[1].length;
              edits.push([at, pm[2]?.length ?? 0, pm[3] ? '::uuid[]' : '::uuid']);
            }
            idx++;
            valStart = j + 1;
            if (c === ')' && depth === 0) break;
          }
        }
        i = j + 1;
        while (/\s|,/.test(sql[i] ?? '')) i++;
      }
    }
    // (3) text-ссылка ⋈ uuid-колонка: приведение uuid-стороны к text (индекс text-ссылки работает)
    for (const x of sql.matchAll(new RegExp(`${col}(\\s*=\\s*)${col}(?!\\s*::)`, 'g'))) {
      const a = typeOf(x[1], x[2], ctx);
      const b = typeOf(x[4], x[5], ctx);
      if (a === 'text' && b === 'uuid') {
        report('text-ref = uuid-col without cast', x[0]);
        edits.push([x.index + x[0].length, 0, '::text']);
      } else if (a === 'uuid' && b === 'text') {
        report('text-ref = uuid-col without cast', x[0]);
        edits.push([x.index + x[0].indexOf(x[3]), 0, '::text']);
      }
    }
    if (FIX && edits.length) {
      for (const [idx, len, rep] of edits.sort((p, q) => q[0] - p[0])) sql = sql.slice(0, idx) + rep + sql.slice(idx + len);
      src = src.slice(0, ch.start) + sql + src.slice(ch.end);
      dirty = true;
    }
  }
  if (FIX && dirty) fs.writeFileSync(file, src);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 1));
else {
  for (const f of findings) console.log(`${f.file}:${f.line}  [${f.kind}]  ${f.snippet}`);
  console.log(`\n${findings.length} findings`);
}
process.exit(findings.length ? 1 : 0);
