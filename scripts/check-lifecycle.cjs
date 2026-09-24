#!/usr/bin/env node
/**
 * Страж реестра жизненного цикла данных (core/lifecycle). ~1–2 с, без сборки: реестр
 * транспилируется из исходников shared на лету (typescript из packages/shared).
 *
 *   реестр     — `lifecycleRegistryProblems()` (тот же, что смоук бута API): длительности только
 *                целыми сутками, пол ≤ умолчание ≤ потолок, нормы у «по закону», hold у классов
 *                legal/tenant/user_content, достижимость DELF от User/Workspace/Chat, доказательство;
 *   покрытие   — у КАЖДОЙ модели schema.prisma, сырой таблицы миграций, профиля файлов
 *                (FILE_PROFILES) и семейства ключей Redis (литералы у вызовов Redis) есть политика,
 *                и наоборот — политика не ссылается на несуществующее;
 *   колонки    — каждая колонка политики (владелец, субъекты, принуждение, фильтры, псевдонимизация,
 *                рёбра) существует в модели / таблице;
 *   рёбра FK   — каждый внешний ключ схемы объявлен ребром удаления родителя (Cascade/Restrict →
 *                deep, SetNull → shallow): новый FK без решения о каскаде — красный;
 *   ПДн        — модель из PII_MODELS стирается (onSubjectErasure ≠ none);
 *   принуждение— drop_partition → таблица партиционирована по этой колонке и PK её содержит;
 *                batched_delete → есть индекс, ведущий колонкой времени или владельца;
 *   корни      — корневая пользовательская сущность (`rootEntity`) имеет мягкое скрытие;
 *   каталоги   — `lifecycle.classes|citations|policies|tables|blobs|redis|derived` в en/kk/ru, без сирот;
 *   хуки       — каждый `handler` принуждения и `registry_hook` удаления организации
 *                зарегистрирован в apps/api/src;
 *   канарейки  — манифест `CANARY_STORES` в verify-lifecycle.cjs перечисляет каждую политику;
 *   ячейки     — ратчет `scripts/lifecycle.cell-readiness.json` (ТОЛЬКО сокращается): индексы
 *                P-моделей, не ведущие ключом владельца; FK между разными владельцами; int4 PK;
 *                findMany без take в методах, возвращающих списки. `--write` сокращает ратчет.
 *
 * Выход 1 при ошибке. На GitHub Actions — аннотации ::error.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'packages', 'shared', 'src');
const MESSAGES = path.join(ROOT, 'packages', 'i18n', 'src', 'messages');
const API_DIR = path.join(ROOT, 'apps', 'api', 'src');
const SCHEMA = path.join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma');
const MIGRATIONS = path.join(ROOT, 'apps', 'api', 'prisma', 'migrations');
const SUITE = path.join(ROOT, 'apps', 'api', 'scripts', 'verify-lifecycle.cjs');
const RATCHET = path.join(ROOT, 'scripts', 'lifecycle.cell-readiness.json');
const LOCALES = ['en', 'kk', 'ru'];
const GH = !!process.env.GITHUB_ACTIONS;
const WRITE = process.argv.includes('--write');

let errors = 0;
const warnings = [];
const err = (msg) => {
  errors++;
  console.error(GH ? `::error::check-lifecycle: ${msg}` : `  ✗ ${msg}`);
};
const warn = (msg) => warnings.push(msg);
const read = (f) => fs.readFileSync(f, 'utf8');

/**
 * ОТЛОЖЕННОЕ ДО ЭТАПА (ратчет стройки, а не исключение): пункты, которые план закрывает
 * позже. Каждая строка — с этапом; этап сдан → строки нет. Пустые списки — цель.
 */
const PENDING = {
  /** Корневые сущности без мягкого скрытия — `+deletedAt` и корзина 30 дней */
  softDelete: {},
  /** Таблицы под drop_partition, ещё не партиционированные */
  partition: {},
  /** Индексы, ведущие колонкой времени/владельца, для batched_delete */
  index: {},
  /** Обработчики purge (`handler`) и хуки удаления организации — регистрируются в API */
  hook: {
    'access.tuples': 'Э3',
    'notifications.events': 'Э3',
    'notifications.rows': 'Э3',
    'notifications.workspace-rows': 'Э3',
    'files.deleted': 'Э3',
    'files.owned': 'Э3',
    'files.upload-tmp': 'Э3',
    'jobs.terminal': 'Э3',
    'chatter.retention': 'Э3',
    'share-links.workspace': 'Э3',
    'approvals.workspace': 'Э3',
    'docs.trash': 'Э3',
    'docs.owned': 'Э3',
    'entitlements.subject': 'Э3',
    'analytics.workspace': 'Э3',
    'keys.workspace': 'Э3',
    'idempotency.inbox': 'Э3',
    'idempotency.keys': 'Э3',
    'visibility.owner': 'Э3',
    'messenger.workspace-chats': 'Э3',
    'messenger.retention': 'Э3',
    'workspaces.purge': 'Э3',
    'workspaces.row': 'Э3',
    'tasks.trash': 'Э3',
    'calendar.trash': 'Э3',
    'shop.owner': 'Э3',
    'finances.owner': 'Э3',
    'finances.trash': 'Э3',
    'drive.workspace': 'Э3',
    'drive.trash': 'Э3',
    'notes.workspace': 'Э3',
    'notes.trash': 'Э3',
    'recorder.trash': 'Э3',
    'lifecycle.exports': 'Э6',
    'lifecycle.hold-store': 'Э4',
    'lifecycle.erasure-requests': 'Э4',
  },
};

// ---------- загрузка реестра: транспиляция TS на лету ----------
let ts;
try {
  ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'packages', 'shared')] }));
} catch {
  err('не найден typescript (packages/shared/node_modules) — выполните pnpm install');
  process.exit(1);
}
const prevTs = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(read(filename), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(out, filename);
};
let reg;
let files;
try {
  reg = require(path.join(SHARED, 'lifecycle', 'index.ts'));
  files = require(path.join(SHARED, 'constants', 'files.ts'));
} catch (e) {
  err(`реестр не загрузился: ${e.message}`);
  process.exit(1);
} finally {
  if (prevTs) require.extensions['.ts'] = prevTs;
  else delete require.extensions['.ts'];
}
const POLICIES = reg.LIFECYCLE_POLICIES;
const IDS = reg.LIFECYCLE_POLICY_IDS;

// ---------- 1. самопроверка реестра ----------
for (const p of reg.lifecycleRegistryProblems()) err(`реестр: ${p}`);

// ---------- 1b. поля политики — только известные (опечатка `retentionDays` = молчаливое «хранить») ----------
const POLICY_KEYS = new Set(['id', 'store', 'owner', 'version', 'dataClass', 'ownerKey', 'subjects', 'legalBasis', 'retention', 'onSubjectErasure', 'onTenantPurge', 'edges', 'tiers', 'enforcement', 'extraRules', 'holdAware', 'proofEvent', 'pause', 'rootEntity', 'exportable']);
const RETENTION_KEYS = new Set(['trigger', 'floorDays', 'defaultDays', 'ceilingDays', 'tenantConfigurable', 'userConfigurable', 'entitlementKey']);
for (const id of IDS) {
  const p = POLICIES[id];
  for (const k of Object.keys(p)) if (!POLICY_KEYS.has(k)) err(`${id}: неизвестное поле политики "${k}"`);
  for (const k of Object.keys(p.retention)) if (!RETENTION_KEYS.has(k)) err(`${id}: неизвестное поле срока "retention.${k}" (длительности — только floorDays/defaultDays/ceilingDays)`);
}

// ---------- 2. схема Prisma ----------
const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);
const schemaTxt = read(SCHEMA);
const ENUMS = new Set([...schemaTxt.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
/** @type {Map<string, any>} */
const MODELS = new Map();
for (const m of schemaTxt.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const name = m[1];
  const body = m[2];
  const table = (body.match(/@@map\("([^"]+)"\)/) || [])[1] || name;
  const schema = (body.match(/@@schema\("([^"]+)"\)/) || [])[1] || 'public';
  const fields = new Map();
  const relations = [];
  const indexes = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('@@')) {
      const im = line.match(/^@@(id|unique|index)\(\s*\[([^\]]+)\]/);
      if (im) indexes.push({ kind: im[1], fields: im[2].split(',').map((s) => s.trim().replace(/\(.*$/, '')), brin: /type:\s*Brin\b/.test(line) });
      continue;
    }
    const fm = line.match(/^(\w+)\s+([\w]+)(\[\])?(\?)?(.*)$/);
    if (!fm) continue;
    const [, fname, ftype, list, opt, attrs] = fm;
    const isScalar = SCALARS.has(ftype) || ENUMS.has(ftype);
    const dbName = (attrs.match(/@map\("([^"]+)"\)/) || [])[1] || fname;
    fields.set(fname, { name: fname, type: ftype, list: !!list, optional: !!opt, scalar: isScalar, dbName, attrs });
    if (/@id\b/.test(attrs)) indexes.push({ kind: 'id', fields: [fname] });
    if (/@unique\b/.test(attrs)) indexes.push({ kind: 'unique', fields: [fname] });
    const rel = attrs.match(/@relation\(([^)]*)\)/);
    if (!isScalar && rel && /fields:\s*\[/.test(rel[1])) {
      const rf = rel[1].match(/fields:\s*\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
      const od = (rel[1].match(/onDelete:\s*(\w+)/) || [])[1] || null;
      relations.push({ field: fname, target: ftype, fields: rf, onDelete: od });
    }
  }
  MODELS.set(name, { name, table, schema, fields, relations, indexes });
}
const dbToField = (model, db) => {
  for (const f of model.fields.values()) if (f.dbName === db) return f.name;
  return null;
};
const fieldToDb = (model, f) => model.fields.get(f)?.dbName ?? f;

// ---------- 3. миграции: сырые таблицы, партиции, индексы ----------
const migrationFiles = fs
  .readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(MIGRATIONS, d.name, 'migration.sql'))
  .filter((f) => fs.existsSync(f))
  .sort();
// Комментарии SQL вырезаются: `-- …` внутри CREATE TABLE прятал следующую колонку от разбора
const sqlAll = migrationFiles
  .map(read)
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/--[^\n]*/g, '');
const qname = (s) => s.replace(/"/g, '');
/** Таблицы, созданные миграциями: схема.имя → { columns:Set, partitionBy?, pk?:[] } */
const SQL_TABLES = new Map();
const tableKey = (raw) => {
  const n = qname(raw);
  return n.includes('.') ? n : `public.${n}`;
};
/**
 * DDL применяется ПО ПОРЯДКУ операторов: `CREATE → RENAME _old → CREATE … PARTITION BY → DROP _old`
 * (перевод журнала в партиции) даёт правильное итоговое состояние только последовательно.
 */
const TABLE_RE = '((?:"?\\w+"?\\.)?"?\\w+"?)';
const DDL = [
  ...[...sqlAll.matchAll(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${TABLE_RE}\\s*\\(([\\s\\S]*?)\\)\\s*(PARTITION BY (?:RANGE|LIST|HASH)\\s*\\(([^)]*)\\))?\\s*;`, 'gi'))].map((m) => ({ at: m.index, op: 'create', m })),
  ...[...sqlAll.matchAll(new RegExp(`ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\\s+${TABLE_RE}\\s+RENAME TO\\s+"?(\\w+)"?`, 'gi'))].map((m) => ({ at: m.index, op: 'rename', m })),
  ...[...sqlAll.matchAll(new RegExp(`ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\\s+${TABLE_RE}\\s+([^;]*?ADD COLUMN[^;]*);`, 'gi'))].map((m) => ({ at: m.index, op: 'add', m })),
  ...[...sqlAll.matchAll(new RegExp(`DROP TABLE(?: IF EXISTS)?\\s+${TABLE_RE}`, 'gi'))].map((m) => ({ at: m.index, op: 'drop', m })),
].sort((a, b) => a.at - b.at);
const DROPPED = new Set();
for (const { op, m } of DDL) {
  const key = tableKey(m[1]);
  if (op === 'create') {
    const cols = new Set();
    let pk = null;
    for (const part of m[2].split(/,(?![^(]*\))/)) {
      const t = part.trim();
      const pkm = t.match(/(?:CONSTRAINT\s+"?\w+"?\s+)?PRIMARY KEY\s*\(([^)]+)\)/i);
      if (pkm) {
        pk = pkm[1].split(',').map((s) => qname(s.trim()));
        continue;
      }
      const cm = t.match(/^"?(\w+)"?\s+[A-Za-z]/);
      if (cm && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(cm[1])) {
        cols.add(cm[1]);
        if (/PRIMARY KEY/i.test(t)) pk = [cm[1]];
      }
    }
    SQL_TABLES.set(key, { columns: cols, partitionBy: m[4] ? m[4].split(',').map((s) => qname(s.trim())) : null, pk });
    DROPPED.delete(key);
  } else if (op === 'rename') {
    const t = SQL_TABLES.get(key);
    if (!t) continue;
    SQL_TABLES.delete(key);
    SQL_TABLES.set(`${key.split('.')[0]}.${m[2]}`, t);
  } else if (op === 'add') {
    const t = SQL_TABLES.get(key);
    if (t) for (const c of m[2].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+"?(\w+)"?/gi)) t.columns.add(c[1]);
  } else if (op === 'drop') {
    SQL_TABLES.delete(key);
    DROPPED.add(key);
  }
}
/** Индексы из сырого SQL: таблица → [ведущая колонка] */
const SQL_INDEX_LEAD = new Map();
for (const m of sqlAll.matchAll(/CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)?\s+"?\w+"?\s+ON\s+(?:ONLY\s+)?((?:"?\w+"?\.)?"?\w+"?)(?:\s+USING\s+\w+)?\s*\(\s*"?(\w+)"?/gi)) {
  const key = tableKey(m[1]);
  if (!SQL_INDEX_LEAD.has(key)) SQL_INDEX_LEAD.set(key, new Set());
  SQL_INDEX_LEAD.get(key).add(m[2]);
}
const PRISMA_TABLES = new Set([...MODELS.values()].map((m) => `${m.schema}.${m.table}`));
const PARTITION_CHILD = /_(\d{4}_\d{2}|\d{4}_\d{2}_\d{2}|\d{8}|p\d+|default)$/;

// ---------- 4. покрытие ----------
const byStore = (kind) => IDS.filter((id) => POLICIES[id].store.kind === kind);
for (const name of MODELS.keys()) if (!reg.lifecycleModelPolicy(name)) err(`модель ${name} без политики жизненного цикла (packages/shared/src/lifecycle/*)`);
for (const id of byStore('model')) if (!MODELS.has(POLICIES[id].store.model)) err(`${id}: политика модели, которой нет в schema.prisma`);
const rawTables = [...SQL_TABLES.keys()].filter((k) => !PRISMA_TABLES.has(k) && !DROPPED.has(k) && !PARTITION_CHILD.test(k));
const tablePolicies = new Map(byStore('table').map((id) => [POLICIES[id].store.table, id]));
for (const t of rawTables) if (!tablePolicies.has(t)) err(`сырая таблица ${t} (миграции) без политики table:${t}`);
for (const [t, id] of tablePolicies) if (t !== 'public._prisma_migrations' && !rawTables.includes(t)) err(`${id}: таблицы ${t} нет в миграциях (или она модель Prisma)`);
const profiles = Object.keys(files.FILE_PROFILES);
const blobPolicies = new Set(byStore('blob').map((id) => POLICIES[id].store.profile));
for (const p of profiles) if (!blobPolicies.has(p)) err(`профиль файлов ${p} (FILE_PROFILES) без политики blob:${p}`);
for (const p of blobPolicies) if (!profiles.includes(p)) err(`blob:${p}: профиля нет в FILE_PROFILES`);

// ---------- 4b. семейства Redis: литералы ключей у вызовов Redis ----------
const redisPolicies = byStore('redis').map((id) => POLICIES[id]);
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const FAMILY_RES = redisPolicies.flatMap((p) => p.store.patterns.map((g) => ({ re: globRe(g), id: p.id })));
const coveredKey = (sample) => FAMILY_RES.some((f) => f.re.test(sample));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const API_FILES = walk(API_DIR);
const REDIS_CALL = /\b(?:redis|client|this\.client|multi|pipeline|pipe|cache)\s*\.\s*(?:get|set|setex|psetex|setnx|del|unlink|incr|incrby|decr|expire|pexpire|ttl|pttl|exists|hget|hset|hmset|hgetall|hdel|hincrby|sadd|srem|smembers|sismember|scard|zadd|zrem|zrange|zrangebyscore|zremrangebyscore|zcard|xadd|xread|xreadgroup|xack|xtrim|xlen|xgroup|xautoclaim|publish|subscribe|getJson|setJson|getdel|mget|mset|eval|evalsha|lpush|rpush|lrange|ltrim|delPattern|scan|withLock|acquireLock|releaseLock)\s*\(|\b(?:withLock|acquireLock|incrWindow|delPattern)\s*\(/;
const KEY_HELPER = /\b\w*(?:Key|KEY|_REDIS|RedisKey)\w*\s*(?:=|:)\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>|['`])/;
const NOT_REDIS = /\b(?:uniqueKey|dedupeKey|idempotencyKey|collapseKey|refKey|routeKey|labelKey|titleKey|i18nKey|messageKey|translationKey|storageKey|objectKey|s3Key|partitionKey|cursorKey|sortKey|queryKey|rqKey|cacheTag)\b/;
const redisUncovered = new Map();
// Объекты ключей `*_REDIS` живут и в shared (KEYS_REDIS, CONSENT_REDIS, VISIBILITY_REDIS) — сканируются тоже
const SHARED_REDIS_FILES = walk(SHARED).filter((f) => /export const \w*_REDIS\s*=\s*\{/.test(read(f)));
for (const f of [...API_FILES, ...SHARED_REDIS_FILES]) {
  const src = read(f);
  // Только файлы, работающие с Redis: иначе литералы AAD и метаданных декораторов похожи на ключи
  if (!/RedisService|ioredis|getClient\(\)|incrWindow|withLock|_REDIS\b/.test(src)) continue;
  const lines = src.split('\n');
  let inRedisObject = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/export const \w*_REDIS\s*=\s*\{/.test(line)) inRedisObject = true;
    const candidate = inRedisObject || REDIS_CALL.test(line) || KEY_HELPER.test(line);
    if (inRedisObject && /^\}\s*(as const)?;?\s*$/.test(line.trim())) inRedisObject = false;
    if (!candidate || NOT_REDIS.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
    // Первый сегмент ≥ 2 символов: `p:${hmac}` — фрагмент составного ключа, не ключ
    for (const m of line.matchAll(/(['`])([a-z][a-z0-9_-]+:[^'`\s]*)\1/g)) {
      const lit = m[2];
      if (/^(https?|data|mailto|tel|urn|sa6|blob|file|image|video|audio|text|application|keys\.|node):/.test(lit)) continue;
      const sample = lit.replace(/\$\{[^}]*\}/g, 'x');
      if (!coveredKey(sample) && !coveredKey(`${sample}x`)) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        redisUncovered.set(`${lit}`, `${rel}:${i + 1}`);
      }
    }
  }
}
for (const [lit, at] of redisUncovered) err(`ключ Redis "${lit}" (${at}) не покрыт ни одним семейством redis:* реестра`);

// ---------- 5. колонки политик ----------
const hasCol = (model, col) => model.fields.has(col);
function colsOfPolicy(p) {
  const out = [];
  const ok = p.ownerKey;
  if (ok.kind === 'polymorphic') out.push(['ownerKey.typeColumn', ok.typeColumn], ['ownerKey.column', ok.column]);
  else if (ok.kind === 'scoped') {
    out.push(['ownerKey.workspaceColumn', ok.workspaceColumn]);
    if (ok.userColumn) out.push(['ownerKey.userColumn', ok.userColumn]);
    if (ok.conversationColumn) out.push(['ownerKey.conversationColumn', ok.conversationColumn]);
  } else if (ok.kind !== 'global' && 'column' in ok) out.push(['ownerKey.column', ok.column]);
  for (const s of p.subjects) out.push([`subjects.${s.role}`, s.column]);
  const en = p.enforcement;
  if (en.kind === 'batched_delete' || en.kind === 'drop_partition') out.push(['enforcement.column', en.column]);
  if (en.kind === 'batched_delete') for (const c of Object.keys(en.filter ?? {})) out.push(['enforcement.filter', c]);
  for (const r of p.extraRules ?? []) {
    if (r.column) out.push(['extraRules.column', r.column]);
    for (const c of Object.keys(r.filter ?? {})) out.push(['extraRules.filter', c]);
  }
  const se = p.onSubjectErasure;
  if (se.kind === 'pseudonymize' || se.kind === 'redact') for (const c of se.fields) out.push([`onSubjectErasure.${se.kind}`, c]);
  if (p.onTenantPurge.kind === 'batched_delete') out.push(['onTenantPurge.column', p.onTenantPurge.column]);
  return out;
}
const pendingSoft = (id, col) => PENDING.softDelete[id] && ['deletedAt', 'trashedAt', 'hiddenAt'].includes(col);
for (const id of IDS) {
  const p = POLICIES[id];
  if (p.store.kind === 'model') {
    const model = MODELS.get(p.store.model);
    if (!model) continue;
    for (const [where, col] of colsOfPolicy(p)) {
      if (col === 'key' || pendingSoft(id, col)) continue;
      if (!hasCol(model, col)) err(`${id}: ${where} = "${col}" — такого поля нет в модели`);
    }
    for (const e of p.edges) {
      if (!e.via) continue;
      const child = MODELS.get(POLICIES[e.to]?.store.model);
      const cols = e.via.split(',');
      const onParent = cols.every((c) => hasCol(model, c));
      const onChild = child ? cols.every((c) => hasCol(child, c)) : false;
      if (!onParent && !onChild && POLICIES[e.to]?.store.kind === 'model') err(`${id}: ребро → ${e.to} via "${e.via}" — такой колонки нет ни у родителя, ни у ребёнка`);
    }
  } else if (p.store.kind === 'table') {
    const t = SQL_TABLES.get(p.store.table);
    if (!t) continue;
    for (const [where, col] of colsOfPolicy(p)) if (col !== 'key' && !t.columns.has(col)) err(`${id}: ${where} = "${col}" — такой колонки нет в таблице ${p.store.table}`);
  }
}

// ---------- 6. внешние ключи схемы = рёбра удаления ----------
for (const child of MODELS.values()) {
  for (const r of child.relations) {
    const parentPolicy = reg.lifecycleModelPolicy(r.target);
    if (!parentPolicy) continue;
    const scalarOptional = r.fields.every((f) => child.fields.get(f)?.optional);
    const action = r.onDelete ?? (scalarOptional ? 'SetNull' : 'Restrict');
    const kind = action === 'SetNull' || action === 'SetDefault' ? 'shallow' : 'deep';
    const via = r.fields.join(',');
    const edge = parentPolicy.edges.find((e) => e.to === child.name && e.via === via);
    if (!edge) err(`FK ${child.name}.${via} → ${r.target} (${action}) не объявлен ребром в политике ${r.target}: { to: '${child.name}', kind: '${kind}', via: '${via}' }`);
    else if (edge.kind !== kind) err(`FK ${child.name}.${via} → ${r.target} (${action}): ребро объявлено как ${edge.kind}, ожидалось ${kind}`);
  }
}

// ---------- 7. ПДн ----------
const piiTxt = read(path.join(API_DIR, 'core', 'keys', 'pii', 'keys.pii.registry.ts'));
for (const m of piiTxt.matchAll(/\bmodel:\s*'(\w+)'/g)) {
  const p = reg.lifecycleModelPolicy(m[1]);
  if (!p) err(`PII_MODELS: ${m[1]} без политики`);
  else if (p.onSubjectErasure.kind === 'none') err(`${m[1]}: модель с ПДн (PII_MODELS) не может иметь onSubjectErasure none`);
}

// ---------- 8. принуждение: партиции и индексы ----------
for (const id of IDS) {
  const p = POLICIES[id];
  const en = p.enforcement;
  let tKey = null;
  let model = null;
  if (p.store.kind === 'model') {
    model = MODELS.get(p.store.model);
    if (!model) continue;
    tKey = `${model.schema}.${model.table}`;
  } else if (p.store.kind === 'table') tKey = p.store.table;
  else continue;
  const sqlT = SQL_TABLES.get(tKey);
  if (en.kind === 'drop_partition') {
    const col = model ? fieldToDb(model, en.column) : en.column;
    if (PENDING.partition[id]) continue;
    if (!sqlT?.partitionBy) err(`${id}: drop_partition, но ${tKey} не партиционирована в миграциях`);
    else if (!sqlT.partitionBy.includes(col)) err(`${id}: drop_partition по "${col}", а ${tKey} партиционирована по (${sqlT.partitionBy.join(', ')})`);
    else if (sqlT.pk && !sqlT.pk.includes(col)) err(`${id}: PK ${tKey} (${sqlT.pk.join(', ')}) не содержит ключ партиции "${col}"`);
  }
  if (en.kind === 'batched_delete') {
    if (PENDING.index[id]) continue;
    const leads = new Set();
    if (model) for (const ix of model.indexes) leads.add(fieldToDb(model, ix.fields[0]));
    for (const c of SQL_INDEX_LEAD.get(tKey) ?? []) leads.add(c);
    const want = [model ? fieldToDb(model, en.column) : en.column];
    const ok = p.ownerKey;
    const ownerCols = ok.kind === 'scoped' ? [ok.workspaceColumn, ok.userColumn].filter(Boolean) : ok.kind === 'polymorphic' ? [ok.typeColumn] : 'column' in ok ? [ok.column] : [];
    // Владелец через родителя — ведёт FK-колонка на родителя (drive_trash: space_id, trashed_at)
    if ('via' in ok && model) for (const r of model.relations) if (r.target === ok.via) ownerCols.push(r.fields[0]);
    // Фильтр раннера (status IN …) — ведущая колонка частичного индекса очереди
    ownerCols.push(...Object.keys(en.filter ?? {}));
    for (const c of ownerCols) want.push(model ? fieldToDb(model, c) : c);
    if (!want.some((c) => leads.has(c))) err(`${id}: batched_delete без индекса, ведущего колонкой времени "${want[0]}" или владельца (${want.slice(1).join(', ') || '—'})`);
  }
  if (p.rootEntity && model && !PENDING.softDelete[id] && !['deletedAt', 'trashedAt', 'hiddenAt'].some((c) => model.fields.has(c))) {
    err(`${id}: корневая пользовательская сущность без мягкого скрытия (deletedAt / trashedAt / hiddenAt)`);
  }
}

// ---------- 9. каталоги ----------
const at = (obj, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const GROUPS = ['policies', 'tables', 'blobs', 'redis', 'derived'];
for (const loc of LOCALES) {
  const file = path.join(MESSAGES, loc, 'lifecycle.json');
  if (!fs.existsSync(file)) {
    err(`нет каталога ${path.relative(ROOT, file)}`);
    continue;
  }
  const cat = JSON.parse(read(file));
  for (const c of reg.LIFECYCLE_DATA_CLASSES) {
    if (typeof at(cat, `classes.${c}.title`) !== 'string') err(`[${loc}] нет lifecycle.classes.${c}.title`);
    if (typeof at(cat, `classes.${c}.description`) !== 'string') err(`[${loc}] нет lifecycle.classes.${c}.description`);
  }
  for (const c of reg.LIFECYCLE_CITATIONS) if (typeof at(cat, `citations.${c}`) !== 'string') err(`[${loc}] нет lifecycle.citations.${c}`);
  const expected = new Set();
  for (const id of IDS) {
    const p = reg.lifecycleCatalogPath(POLICIES[id]);
    expected.add(p);
    if (typeof at(cat, `${p}.title`) !== 'string') err(`[${loc}] нет lifecycle.${p}.title (${id})`);
  }
  for (const g of GROUPS) for (const k of Object.keys(cat[g] ?? {})) if (!expected.has(`${g}.${k}`)) err(`[${loc}] сирота каталога lifecycle.${g}.${k} — политики нет`);
}

// ---------- 10. хуки и обработчики зарегистрированы в API ----------
const apiText = API_FILES.map(read).join('\n');
const registered = (key) => new RegExp(`\\.register\\(\\s*['\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\`]`).test(apiText);
const hookKeys = new Set();
for (const id of IDS) {
  const p = POLICIES[id];
  if (p.enforcement.kind === 'batched_delete' && p.enforcement.handler) hookKeys.add(p.enforcement.handler);
  if (p.onTenantPurge.kind === 'registry_hook') hookKeys.add(p.onTenantPurge.key);
}
for (const k of hookKeys) if (!PENDING.hook[k] && !registered(k)) err(`обработчик/хук "${k}" объявлен в реестре, но не зарегистрирован в apps/api/src (.register('${k}', …))`);
for (const k of Object.keys(PENDING.hook)) if (!hookKeys.has(k)) err(`PENDING.hook "${k}" — такого ключа нет в реестре, строку убрать`);

// ---------- 11. манифест канареечного сьюта ----------
if (!fs.existsSync(SUITE)) err(`нет сьюта ${path.relative(ROOT, SUITE)} (манифест CANARY_STORES)`);
else {
  const txt = read(SUITE);
  const m = txt.match(/const CANARY_STORES\s*=\s*\[([\s\S]*?)\];/);
  if (!m) err('verify-lifecycle.cjs: нет манифеста CANARY_STORES');
  else {
    const listed = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    for (const id of IDS) if (!listed.has(id)) err(`CANARY_STORES (verify-lifecycle.cjs) не перечисляет хранилище ${id}`);
    for (const id of listed) if (!POLICIES[id]) err(`CANARY_STORES перечисляет ${id}, которого нет в реестре`);
  }
}

// ---------- 12. ратчет «готовность к ячейкам» (только сокращается) ----------
const readiness = { indexNotOwnerLed: [], crossOwnerFk: [], int4Pk: [], findManyWithoutTake: [] };
const ownerColOf = (p) => (p.ownerKey.kind === 'global' ? null : 'column' in p.ownerKey ? p.ownerKey.column : p.ownerKey.kind === 'scoped' ? p.ownerKey.workspaceColumn : p.ownerKey.kind === 'polymorphic' ? p.ownerKey.column : null);
for (const id of byStore('model')) {
  const p = POLICIES[id];
  const model = MODELS.get(p.store.model);
  if (!model) continue;
  const oc = ownerColOf(p);
  if (oc && oc !== 'id') {
    for (const ix of model.indexes) {
      if (ix.kind === 'id') continue;
      // BRIN — сводка физического порядка журнала: пути к строке не задаёт, в ячейке — свой
      if (ix.brin) continue;
      if (ix.fields[0] !== oc && !(p.ownerKey.kind === 'polymorphic' && ix.fields[0] === p.ownerKey.typeColumn)) readiness.indexNotOwnerLed.push(`${id}(${ix.fields.join(',')})`);
    }
  }
  for (const f of model.fields.values()) if (/@id\b/.test(f.attrs) && f.type === 'Int') readiness.int4Pk.push(`${id}.${f.name}`);
  for (const r of model.relations) {
    const parent = reg.lifecycleModelPolicy(r.target);
    if (!parent) continue;
    const a = p.ownerKey.kind;
    const b = parent.ownerKey.kind;
    if (a === 'global' || b === 'global' || 'via' in p.ownerKey || 'via' in parent.ownerKey) continue;
    if (a !== b) readiness.crossOwnerFk.push(`${id}.${r.fields.join(',')}→${r.target}`);
  }
}
for (const f of API_FILES) {
  if (!/\.service\.ts$/.test(f)) continue;
  const txt = read(f);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  for (const mm of txt.matchAll(/async\s+(\w+)\s*\([^)]*\)\s*:\s*Promise<([^>]*(?:<[^>]*>)?[^>]*)\[\]>\s*\{/g)) {
    const start = mm.index + mm[0].length;
    let depth = 1;
    let i = start;
    while (i < txt.length && depth > 0) {
      if (txt[i] === '{') depth++;
      else if (txt[i] === '}') depth--;
      i++;
    }
    const body = txt.slice(start, i);
    for (const fm of body.matchAll(/\.findMany\(/g)) {
      let d = 1;
      let j = fm.index + fm[0].length;
      const s = j;
      while (j < body.length && d > 0) {
        if (body[j] === '(') d++;
        else if (body[j] === ')') d--;
        j++;
      }
      if (!/\btake\s*:/.test(body.slice(s, j))) {
        readiness.findManyWithoutTake.push(`${rel}#${mm[1]}`);
        break;
      }
    }
  }
}
for (const k of Object.keys(readiness)) readiness[k] = [...new Set(readiness[k])].sort();
const prevRatchet = fs.existsSync(RATCHET) ? JSON.parse(read(RATCHET)) : null;
if (!prevRatchet || WRITE) {
  if (prevRatchet && WRITE) {
    for (const k of Object.keys(readiness)) {
      const grown = readiness[k].filter((x) => !(prevRatchet[k] ?? []).includes(x));
      if (grown.length) err(`ратчет ${k} растёт (${grown.slice(0, 5).join('; ')}${grown.length > 5 ? ' …' : ''}) — --write только сокращает; исправьте код`);
    }
  }
  if (!errors) {
    fs.writeFileSync(RATCHET, JSON.stringify({ _: 'Ратчет готовности к ячейкам (check-lifecycle): только сокращается. Новый пункт — исправить код, а не дописать сюда.', ...readiness }, null, 2) + '\n');
    console.log(`  ↻ ${path.relative(ROOT, RATCHET)} записан`);
  }
} else {
  for (const k of Object.keys(readiness)) {
    const prev = new Set(prevRatchet[k] ?? []);
    const grown = readiness[k].filter((x) => !prev.has(x));
    for (const g of grown) err(`готовность к ячейкам (${k}): новый пункт ${g} — индекс/FK/PK/выборку исправить (ратчет только сокращается)`);
    const shrunk = [...prev].filter((x) => !readiness[k].includes(x));
    if (shrunk.length) warn(`ратчет ${k} может сократиться на ${shrunk.length} (запустите pnpm check:lifecycle --write)`);
  }
}

// ---------- итог ----------
const pend = Object.entries(PENDING).map(([k, v]) => [k, Object.keys(v).length]).filter(([, n]) => n);
if (pend.length) warn(`отложено до этапа: ${pend.map(([k, n]) => `${k}=${n}`).join(', ')}`);
for (const w of warnings) console.log(`  ! ${w}`);
if (errors) {
  console.error(`\ncheck-lifecycle: ${errors} ошибок`);
  process.exit(1);
}
const counts = ['model', 'table', 'blob', 'redis', 'derived'].map((k) => `${byStore(k).length} ${k}`).join(', ');
console.log(`check-lifecycle: ok — ${IDS.length} политик (${counts}); ячейки: ${Object.entries(readiness).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
