#!/usr/bin/env node
/**
 * Страж реестра событий аналитики (core/analytics). ~1 с, без сборки: читает исходники.
 *
 *   каталог   — у каждого ключа реестра есть `analytics.events.<key>.title|description`
 *               в en/kk/ru; у каждой области `ANALYTICS_AREAS` — `analytics.areas.<key>`;
 *               в каталоге нет ключей событий, которых нет в реестре;
 *   имена     — имя свойства не содержит запрещённого слова (`ANALYTICS_DENY_PROP_WORDS`
 *               из packages/shared/src/analytics/types.ts — единственный источник);
 *   владелец  — `service` события равен первому сегменту ключа;
 *   источник  — ключ с `source: 'server'` не встречается строкой в apps/web и apps/mobile
 *               (клиент такой ключ слать не должен — приём его всё равно отвергнет);
 *   отправка  — ключ `planned` уже отправляется (`track('<key>'` в клиентах, `track(tx, '<key>'`
 *               в apps/api/src) → ошибка «переведите в live»; у ключа `live` отправки нет
 *               нигде → предупреждение (объявлен, но не придёт никогда: planned или удалить);
 *   потолок   — живых ключей не больше 150 (предупреждение).
 *
 * Выход 1 при ошибке. На GitHub Actions — аннотации ::error.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REG_DIR = path.join(ROOT, 'packages', 'shared', 'src', 'analytics');
const TYPES = path.join(REG_DIR, 'types.ts');
const MESSAGES = path.join(ROOT, 'packages', 'i18n', 'src', 'messages');
const LOCALES = ['en', 'kk', 'ru'];
const CLIENT_DIRS = [path.join(ROOT, 'apps', 'web', 'src'), path.join(ROOT, 'apps', 'mobile', 'src'), path.join(ROOT, 'apps', 'mobile', 'app')];
const MAX_LIVE = 150;
const GH = !!process.env.GITHUB_ACTIONS;

let errors = 0;
let warnings = 0;
const err = (msg) => {
  errors++;
  console.error(GH ? `::error::check-analytics: ${msg}` : `  ✗ ${msg}`);
};
const warn = (msg) => {
  warnings++;
  console.warn(GH ? `::warning::check-analytics: ${msg}` : `  ! ${msg}`);
};

const read = (f) => fs.readFileSync(f, 'utf8');

// ---------- словарь: запрещённые слова и области ----------
const typesTxt = read(TYPES);
const denyBlock = /ANALYTICS_DENY_PROP_WORDS\s*=\s*\[([\s\S]*?)\]/.exec(typesTxt);
if (!denyBlock) {
  err(`не найден ANALYTICS_DENY_PROP_WORDS в ${path.relative(ROOT, TYPES)}`);
}
const DENY = new Set([...(denyBlock?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
const areasBlock = /ANALYTICS_AREAS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(typesTxt);
const AREAS = new Set([...(areasBlock?.[1] ?? '').matchAll(/^\s*([a-z]+):\s*\{/gm)].map((m) => m[1]));
if (!AREAS.size) err('не найден словарь ANALYTICS_AREAS');

const propWords = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter(Boolean);

// ---------- реестр: разбор файлов сервисов ----------
/** Блоки `'<key>': { … }` верхнего уровня defineAnalyticsEvents — по балансу скобок. */
function registryBlocks(text) {
  const out = [];
  const re = /^\s*'([a-z_]+(?:\.[a-z_]+)+)':\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    out.push({ key: m[1], body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const registry = new Map();
for (const file of fs.readdirSync(REG_DIR)) {
  if (!file.endsWith('.ts') || ['types.ts', 'index.ts', 'routes.ts'].includes(file)) continue;
  const rel = path.relative(ROOT, path.join(REG_DIR, file));
  for (const { key, body } of registryBlocks(read(path.join(REG_DIR, file)))) {
    if (registry.has(key)) err(`${rel}: ключ ${key} объявлен дважды`);
    const field = (name) => new RegExp(`\\b${name}:\\s*'([a-z_]+)'`).exec(body)?.[1] ?? null;
    const propsPart = /props:\s*([\s\S]*?)\n\s*version:/.exec(body)?.[1] ?? '';
    const props = [...propsPart.matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*):\s*(?:z\.|prop[A-Z]|areaSchema|workspaceRoleSchema|subjectTypeSchema)/g)].map((p) => p[1]);
    registry.set(key, { file: rel, service: field('service'), source: field('source'), status: field('status'), props });
  }
}
if (!registry.size) err('реестр событий пуст: packages/shared/src/analytics/*.ts');

let live = 0;
for (const [key, def] of registry) {
  const first = key.split('.')[0];
  if (!/^[a-z]+\.[a-z_]+\.[a-z_]+$/.test(key)) err(`${def.file}: ключ ${key} — ожидается <service>.<object>.<action>`);
  if (def.service !== first) err(`${def.file}: у ${key} service '${def.service}' ≠ первому сегменту '${first}'`);
  if (def.service && !AREAS.has(def.service)) err(`${def.file}: у ${key} неизвестная область '${def.service}' (нет в ANALYTICS_AREAS)`);
  for (const prop of def.props) {
    const bad = propWords(prop).find((w) => DENY.has(w));
    if (bad) err(`${def.file}: свойство ${key}.${prop} содержит запрещённое слово «${bad}» — персональные данные и свободный текст в аналитику не пишутся`);
  }
  if (def.status === 'live') live++;
}
if (live > MAX_LIVE) warn(`живых ключей ${live} > ${MAX_LIVE}: пересмотрите реестр (deprecated → удалить)`);

// ---------- каталоги ----------
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
  return out;
}
for (const locale of LOCALES) {
  const file = path.join(MESSAGES, locale, 'analytics.json');
  if (!fs.existsSync(file)) {
    err(`нет каталога messages/${locale}/analytics.json`);
    continue;
  }
  let flat;
  try {
    flat = flatten(JSON.parse(read(file)), '', new Set());
  } catch (e) {
    err(`messages/${locale}/analytics.json не разбирается: ${e.message}`);
    continue;
  }
  const missing = [];
  for (const key of registry.keys()) {
    for (const part of ['title', 'description']) if (!flat.has(`events.${key}.${part}`)) missing.push(`events.${key}.${part}`);
  }
  for (const area of AREAS) if (!flat.has(`areas.${area}`)) missing.push(`areas.${area}`);
  if (missing.length) err(`messages/${locale}/analytics.json — нет ${missing.length} ключей:\n    ${missing.join('\n    ')}`);
  const orphans = [...flat]
    .filter((k) => k.startsWith('events.'))
    .map((k) => k.replace(/^events\./, '').replace(/\.(title|description)$/, ''))
    .filter((k, i, a) => a.indexOf(k) === i && !registry.has(k));
  if (orphans.length) err(`messages/${locale}/analytics.json — события вне реестра: ${orphans.join(', ')}`);
}

// ---------- серверные ключи в клиентах ----------
const serverKeys = [...registry].filter(([, d]) => d.source === 'server').map(([k]) => k);
function walk(dir, files) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) files.push(p);
  }
  return files;
}
// Ищется ОТПРАВКА (`track('<key>'` / `track("<key>"`), а не упоминание: конструктор отчётов
// законно ссылается на серверный факт как на шаг воронки — это чтение, а не запись.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const dir of CLIENT_DIRS) {
  for (const f of walk(dir, [])) {
    const txt = read(f);
    for (const key of serverKeys) {
      if (new RegExp(`\\btrack\\s*\\(\\s*['"\`]${escapeRe(key)}['"\`]`).test(txt)) {
        err(`${path.relative(ROOT, f)}: серверный ключ ${key} отправляется из клиента — факт пишет сервер из транзакции, клиент шлёт только «увидел/попытался»`);
      }
    }
  }
}

// ---------- отправка: planned ↔ live ----------
// Отправка — литеральный ключ первым аргументом `track(` (клиент) или вторым после `tx`/`null`
// (сервер). Упоминание ключа в конструкторе или системном дашборде отправкой не считается.
const API_DIR = path.join(ROOT, 'apps', 'api', 'src');
const sendRe = (key) => new RegExp(`\\btrack\\s*\\(\\s*(?:[A-Za-z_$][\\w$.]*\\s*,\\s*)?['"\`]${escapeRe(key)}['"\`]`);
const clientTexts = CLIENT_DIRS.flatMap((d) => walk(d, [])).map((f) => read(f));
const apiTexts = walk(API_DIR, []).map((f) => read(f));
for (const [key, def] of registry) {
  const re = sendRe(key);
  const sent = (def.source !== 'server' && clientTexts.some((txt) => re.test(txt))) || (def.source !== 'client' && apiTexts.some((txt) => re.test(txt)));
  if (def.status === 'planned' && sent) err(`${def.file}: ключ ${key} помечен planned, но уже отправляется — переведите статус в live`);
  if (def.status === 'live' && !sent) warn(`${def.file}: у живого ключа ${key} нет отправки (track) — событие не придёт никогда: пометьте planned или удалите`);
}

if (errors) {
  console.error(`check-analytics: ${errors} ошибок, ${warnings} предупреждений`);
  process.exit(1);
}
console.log(`check-analytics: ok — ${registry.size} событий (${live} живых), ${AREAS.size} областей${warnings ? `, ${warnings} предупреждений` : ''}`);
