#!/usr/bin/env node
/* eslint-disable */
// check-migrations — страж миграций без простоя (plan §9, docs/operations_migrations… → docs/lifecycle_engine.md).
//
// Каждая миграция ПОСЛЕ отсечки (раньше прода не было — старые файлы не переписываются):
//   - заголовок `SET lock_timeout` + `SET statement_timeout` — миграция не висит в очереди за
//     долгой транзакцией, держа ACCESS EXCLUSIVE для всех за собой (очередь блокировок);
//   - CREATE/DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY — ЕДИНСТВЕННЫЙ оператор файла:
//     многооператорный файл Prisma исполняет одной неявной транзакцией (#22922), а
//     CONCURRENTLY внутри транзакции запрещён (заголовок таймаутов в таком файле не нужен);
//   - запрещено: CREATE TABLE … PARTITION OF (лист — функцией владельца `lifecycle_ensure_partition`:
//     CHECK + ATTACH без ACCESS EXCLUSIVE на родителя), DEFAULT-партиция, int4-ключ (serial/
//     integer PK — переполнение, Basecamp 2018), ADD COLUMN … DEFAULT <изменчивое> (перезапись
//     таблицы: now()/clock_timestamp()/random()/gen_random_uuid()/uuidv7());
//   - на БОЛЬШИХ таблицах: CREATE INDEX без CONCURRENTLY, SET NOT NULL без предварительного
//     CHECK … NOT VALID + VALIDATE, ALTER COLUMN … TYPE (перезапись), FOREIGN KEY без NOT VALID
//     (полный скан под замком). Такие изменения — онлайн-раннером `apps/api/scripts/db-online-ddl.cjs`.
//
// Проверка на срабатывание: подсадить миграцию с нарушением → красный; убрать → зелёный.
// Запуск: pnpm check:migrations
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'apps', 'api', 'prisma', 'migrations');
/** Отсечка: миграции с именем ≤ этого (до прода, Э0–Э3 архитектуры данных) не проверяются. */
const CUTOFF = '20260926000100_lifecycle_actor_indexes';
/** Большие (горячие) таблицы — изменения только онлайн (без долгих замков и перезаписи). */
const BIG_TABLES = new Set([
  'messages', 'chat_members', 'chatter_entries', 'notifications', 'notification_events', 'notification_deliveries',
  'search_documents', 'relation_tuples', 'file_objects', 'file_links', 'ledger_transfers', 'tasks', 'jobs',
  'security_events', 'sessions', 'webhook_deliveries', 'api_access_log', 'lifecycle_deleted_rows', 'events', 'keys', 'responses',
]);
const GH = !!process.env.GITHUB_ACTIONS;
/**
 * Защищённое (владелец `sa6_data_owner` / `sa6_audit_owner`, db-roles.sql). У роли миграций
 * членство в ролях-владельцах БЕЗ наследования: миграция, которая меняет такие таблицы, их
 * функции или листы, обязана взять роль явно — `SET LOCAL ROLE …` (транзакция миграции).
 * Миграции с именем ≤ ROLE_CUTOFF исполнял суперпользователь (прода ещё не было).
 */
const ROLE_CUTOFF = '20261002000000_lifecycle_holds_platform_kind';
const DATA_OWNED = new Set([
  'ledger_transfers', 'escrow_agreements', 'escrow_holds', 'card_skin_transfers', 'fin_audit_logs',
  'lifecycle_holds', 'lifecycle_erasure_journal', 'lifecycle_hold_store', 'lifecycle_hold_extractions',
  'lifecycle_partition_specs', 'lifecycle_partition_archives', 'api_access_log', 'notification_deliveries', 'webhook_deliveries', 'lifecycle_deleted_rows',
]);
const AUDIT_OWNED = new Set(['security_events', 'security_digests', 'security_partition_archives', 'platform_command_receipts']);
const DATA_FN = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?)\s+(?:"?public"?\.)?"?lifecycle_\w+/i;
const AUDIT_FN = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?)\s+(?:"?public"?\.)?"?(?:audit_|security_)\w+/i;
const TABLE_DDL = /^(?:ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER|ALTER\s+TRIGGER|DROP\s+TRIGGER|COMMENT\s+ON\s+(?:TABLE|COLUMN))\b/i;

let errors = 0;
const err = (file, msg) => {
  errors++;
  console.error(GH ? `::error file=${file}::check-migrations: ${msg}` : `  ✗ ${file}: ${msg}`);
};

/** Операторы файла без комментариев и строк (для разбора ключевых слов). */
function statements(sql) {
  const clean = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    // тела функций и строковые литералы не разбираем как DDL
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
  return clean
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const tableOf = (s) => (s.match(/\b(?:ON|TABLE)\s+(?:ONLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/i) || [])[1];

const dirs = fs
  .readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name > CUTOFF)
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  const file = path.join('apps', 'api', 'prisma', 'migrations', dir, 'migration.sql');
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  const stmts = statements(fs.readFileSync(full, 'utf8'));
  const concurrent = stmts.filter((s) => /\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bREINDEX\b.*\bCONCURRENTLY\b/i.test(s));
  if (concurrent.length) {
    if (stmts.length !== 1) err(file, `CONCURRENTLY — единственный оператор файла (Prisma исполняет файл одной транзакцией), а здесь ${stmts.length}`);
    continue;
  }
  const [first, second] = stmts;
  const isSet = (s, name) => new RegExp(`^SET\\s+(LOCAL\\s+)?${name}\\b`, 'i').test(s ?? '');
  if (!((isSet(first, 'lock_timeout') && isSet(second, 'statement_timeout')) || (isSet(first, 'statement_timeout') && isSet(second, 'lock_timeout')))) {
    err(file, 'нет заголовка SET lock_timeout / SET statement_timeout первыми операторами');
  }
  // Защищённое — только под ролью владельца (у роли миграций членство без наследования)
  if (dir > ROLE_CUTOFF) {
    const needs = { sa6_data_owner: [], sa6_audit_owner: [] };
    for (const s of stmts) {
      const t = tableOf(s);
      const table = TABLE_DDL.test(s) ? t : null;
      const dataTable = table && (DATA_OWNED.has(table) || /\banalytics\s*\.\s*"?events"?\b|\bidem\s*\.\s*"?responses"?\b/i.test(s));
      if (dataTable || DATA_FN.test(s)) needs.sa6_data_owner.push(s);
      if ((table && AUDIT_OWNED.has(table)) || AUDIT_FN.test(s)) needs.sa6_audit_owner.push(s);
    }
    const setRole = (role) => stmts.some((s) => new RegExp(`^SET\\s+(LOCAL\\s+)?ROLE\\s+"?${role}"?$`, 'i').test(s));
    for (const [role, hits] of Object.entries(needs)) {
      if (hits.length && !setRole(role)) err(file, `меняет защищённое (${role}) без SET LOCAL ROLE ${role}: ${hits[0].slice(0, 90)}`);
    }
    const plainSetRole = stmts.some((s) => /^SET\s+ROLE\b/i.test(s));
    if (plainSetRole && !stmts.some((s) => /^RESET\s+ROLE$/i.test(s))) err(file, 'SET ROLE без RESET ROLE в конце (или SET LOCAL ROLE — роль живёт только в транзакции миграции)');
  }
  for (const s of stmts) {
    const t = tableOf(s);
    const big = t && BIG_TABLES.has(t);
    // SECURITY DEFINER: путь поиска только `pg_catalog, pg_temp` — схема public открыта на запись
    // роли приложения, а функция из public с «лучшим совпадением типов» (format(text, text, text)
    // против VARIADIC "any") исполнилась бы от ВЛАДЕЛЬЦА данных
    if (/\bSECURITY\s+DEFINER\b/i.test(s)) {
      const sp = (s.match(/\bSET\s+search_path\s*(?:=|TO)\s*([^;]*?)(?=\s+(?:SET|AS|LANGUAGE|IMMUTABLE|STABLE|VOLATILE|STRICT|PARALLEL|COST|RETURNS|SECURITY)\b|$)/i) || [])[1];
      if (!sp || !/^pg_catalog\s*,\s*pg_temp$/i.test(sp.trim())) err(file, `SECURITY DEFINER без SET search_path = pg_catalog, pg_temp (объекты public — с явной схемой): ${s.slice(0, 90)}`);
    }
    if (/\bCREATE\s+TABLE\b[\s\S]*\bPARTITION\s+OF\b/i.test(s)) err(file, `CREATE TABLE … PARTITION OF — лист только функцией владельца lifecycle_ensure_partition (ATTACH без ACCESS EXCLUSIVE): ${s.slice(0, 90)}`);
    if (/\bPARTITION\s+OF\b[\s\S]*\bDEFAULT\b|\bATTACH\s+PARTITION\b[\s\S]*\bDEFAULT\b/i.test(s)) err(file, `DEFAULT-партиция запрещена (ловит строки мимо срока): ${s.slice(0, 90)}`);
    if (/\b(SERIAL|SMALLSERIAL)\b/i.test(s) || /\b(INTEGER|INT4|INT)\b[^,]*\bPRIMARY\s+KEY\b/i.test(s)) err(file, `int4-ключ запрещён (bigint / uuid): ${s.slice(0, 90)}`);
    if (/\bADD\s+COLUMN\b[^,]*\bDEFAULT\s+(now\(\)|clock_timestamp\(\)|random\(\)|gen_random_uuid\(\)|uuidv7\(\)|timeofday\(\)|statement_timestamp\(\))/i.test(s)) err(file, `ADD COLUMN … DEFAULT <изменчивое> перезаписывает таблицу: ${s.slice(0, 90)}`);
    if (!big) continue;
    if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s)) err(file, `CREATE INDEX на большой таблице ${t} — только CONCURRENTLY отдельным файлом (или db-online-ddl.cjs)`);
    if (/\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i.test(s)) {
      const col = (s.match(/ALTER\s+COLUMN\s+"?(\w+)"?/i) || [])[1];
      const prepared = stmts.some((x) => new RegExp(`CHECK\\s*\\(\\s*"?${col}"?\\s+IS\\s+NOT\\s+NULL\\s*\\)\\s*NOT\\s+VALID`, 'i').test(x));
      if (!prepared) err(file, `SET NOT NULL на большой таблице ${t} без CHECK (… IS NOT NULL) NOT VALID + VALIDATE — полный скан под ACCESS EXCLUSIVE`);
    }
    if (/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(s)) err(file, `ALTER COLUMN … TYPE на большой таблице ${t} — перезапись под ACCESS EXCLUSIVE (новая колонка + фоновый перенос)`);
    if (/\bFOREIGN\s+KEY\b/i.test(s) && !/\bNOT\s+VALID\b/i.test(s)) err(file, `FOREIGN KEY на большой таблице ${t} без NOT VALID (+ VALIDATE CONSTRAINT отдельно)`);
  }
}

if (errors) {
  console.error(`\ncheck-migrations: ${errors} ошибок`);
  process.exit(1);
}
console.log(`check-migrations: ok — миграций после отсечки ${dirs.length}`);
