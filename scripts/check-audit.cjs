#!/usr/bin/env node
/**
 * Страж реестра событий журнала безопасности (core/audit). ~1 с, без сборки: читает исходники.
 *
 *   каталог    — у каждого ключа реестра есть `audit.events.<key>.title|body` в en/kk/ru;
 *                в каталоге нет событий, которых нет в реестре;
 *   имена      — имя детали не содержит запрещённого слова (`AUDIT_DENY_DETAIL_WORDS`
 *                из packages/shared/src/audit/types.ts — единственный источник);
 *   категория  — `category` равна первому сегменту ключа (`auth.session.*` → `session`);
 *   зрители    — у каждого ключа `visibility` из пресетов `AUDIT_VIS`; у `platform.*` —
 *                только `AUDIT_VIS.platform` (действия сотрудников людям не показываются);
 *   окно       — `windowExempt` только у `pd.*` и `consents.*`;
 *   запись     — у живого ключа есть запись в apps/api/src (литерал ключа вне реестра);
 *                у `planned` записи нет (иначе — «переведите в live»); литерал `key: '<x>'`
 *                в вызове движка, которого нет в реестре, — ошибка;
 *   потолок    — ключей не больше 200.
 *
 * Выход 1 при ошибке. На GitHub Actions — аннотации ::error.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REG_DIR = path.join(ROOT, 'packages', 'shared', 'src', 'audit');
const TYPES = path.join(REG_DIR, 'types.ts');
const MESSAGES = path.join(ROOT, 'packages', 'i18n', 'src', 'messages');
const API_DIR = path.join(ROOT, 'apps', 'api', 'src');
const API_SCRIPTS = path.join(ROOT, 'apps', 'api', 'scripts');
const LOCALES = ['en', 'kk', 'ru'];
const MAX_KEYS = 200;
const NOT_AREA_FILES = new Set(['types.ts', 'index.ts', 'ocsf.ts', 'vocab.ts']);
const GH = !!process.env.GITHUB_ACTIONS;

let errors = 0;
let warnings = 0;
const err = (msg) => {
  errors++;
  console.error(GH ? `::error::check-audit: ${msg}` : `  ✗ ${msg}`);
};
const warn = (msg) => {
  warnings++;
  console.warn(GH ? `::warning::check-audit: ${msg}` : `  ! ${msg}`);
};
const read = (f) => fs.readFileSync(f, 'utf8');

// ---------- словарь: запрещённые слова и категории ----------
const typesTxt = read(TYPES);
const denyBlock = /AUDIT_DENY_DETAIL_WORDS\s*=\s*\[([\s\S]*?)\]/.exec(typesTxt);
if (!denyBlock) err(`не найден AUDIT_DENY_DETAIL_WORDS в ${path.relative(ROOT, TYPES)}`);
const DENY = new Set([...(denyBlock?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
const catBlock = /AUDIT_CATEGORIES\s*=\s*\[([^\]]*)\]/.exec(typesTxt);
const CATEGORIES = new Set([...(catBlock?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
if (!CATEGORIES.size) err('не найден словарь AUDIT_CATEGORIES');

const words = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
const categoryOf = (key) => (key.startsWith('auth.session.') ? 'session' : key.split('.')[0]);

// ---------- реестр: разбор файлов областей ----------
/** Блоки `'<key>': { … }` или `'<key>': fn(...)` верхнего уровня — по балансу скобок. */
function registryBlocks(text) {
  const out = [];
  const re = /^\s*'([a-z_]+(?:\.[a-z_]+)+)':\s*/gm;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex;
    const open = text[i] === '{' ? '{' : '(';
    const close = open === '{' ? '}' : ')';
    if (open === '(') {
      const paren = text.indexOf('(', i);
      if (paren < 0) continue;
      i = paren;
    }
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ key: m[1], body: text.slice(start, i + 1), call: open === '(' ? /(\w+)\s*\($/.exec(text.slice(re.lastIndex, start + 1))?.[1] ?? null : null });
    re.lastIndex = i + 1;
  }
  return out;
}

/**
 * Хелперы-фабрики файла (`const crypto = (severity, …) => ({ … })`): параметры (там бывает
 * умолчание зрителей) и тело разбираются как продолжение тела ключа, который их зовёт.
 */
function factories(text) {
  const out = new Map();
  for (const m of text.matchAll(/^const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*\(\{([\s\S]*?)\}\)\s*as const/gm)) out.set(m[1], { params: m[2], body: m[3] });
  return out;
}

const registry = new Map();
for (const file of fs.readdirSync(REG_DIR)) {
  if (!file.endsWith('.ts') || NOT_AREA_FILES.has(file)) continue;
  const full = path.join(REG_DIR, file);
  const rel = path.relative(ROOT, full);
  const text = read(full);
  const facs = factories(text);
  for (const { key, body, call } of registryBlocks(text)) {
    if (registry.has(key)) err(`${rel}: ключ ${key} объявлен дважды`);
    // Ключ-вызов фабрики `crypto('low', …)` либо объект со спредом `{ ...detect('high'), … }`
    const fac = facs.get(call ?? '') ?? facs.get(/\.\.\.(\w+)\(/.exec(body)?.[1] ?? '') ?? { params: '', body: '' };
    const facBody = fac.body;
    const whole = `${facBody}\n${body}`;
    const field = (name) => new RegExp(`\\b${name}:\\s*'([a-z_]+)'`).exec(body)?.[1] ?? new RegExp(`\\b${name}:\\s*'([a-z_]+)'`).exec(facBody)?.[1] ?? null;
    // Зрители: явно в теле ключа → аргументом фабрики → в теле фабрики → умолчанием её параметра
    const vis =
      /visibility:\s*AUDIT_VIS\.(\w+)/.exec(body)?.[1] ??
      (call || /\.\.\.\w+\(/.test(body) ? /AUDIT_VIS\.(\w+)/.exec(body)?.[1] : null) ??
      /visibility:\s*AUDIT_VIS\.(\w+)/.exec(facBody)?.[1] ??
      /=\s*AUDIT_VIS\.(\w+)/.exec(fac.params)?.[1] ??
      null;
    const detailsPart = /details:\s*([\s\S]*?)(?:\n\s{4}(?:vocab|ocsf|subjectFrom|windowExempt|status|notify|disputable):|$)/.exec(body)?.[1] ?? '';
    const details = [...detailsPart.matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*):\s*(?:z\.|detail[A-Z]|keyKind|fields|role|basis|recipient|stepUpPurpose|loginMethod|reveal)/g)].map((p) => p[1]);
    registry.set(key, {
      file: rel,
      category: field('category'),
      status: field('status') ?? 'live',
      vis,
      windowExempt: /windowExempt:\s*true/.test(whole),
      details,
    });
  }
}
// Детали фабрик (общие схемы `cryptoDetails`, `finding`, `pdDetails`) — отдельной проверкой имён
for (const file of fs.readdirSync(REG_DIR)) {
  if (!file.endsWith('.ts') || NOT_AREA_FILES.has(file)) continue;
  const rel = path.relative(ROOT, path.join(REG_DIR, file));
  const text = read(path.join(REG_DIR, file));
  for (const m of text.matchAll(/^const\s+(\w+)\s*=\s*z\s*\n?\s*\.object\(\{([\s\S]*?)\}\)/gm)) {
    for (const p of m[2].matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*):\s*(?:z\.|detail[A-Z]|recipient|basis)/g)) {
      const bad = words(p[1]).find((w) => DENY.has(w));
      if (bad) err(`${rel}: деталь ${m[1]}.${p[1]} содержит запрещённое слово «${bad}»`);
    }
  }
}
if (!registry.size) err('реестр событий пуст: packages/shared/src/audit/*.ts');
if (registry.size > MAX_KEYS) warn(`ключей ${registry.size} > ${MAX_KEYS}: пересмотрите реестр`);

for (const [key, def] of registry) {
  if (!/^[a-z]+(\.[a-z_]+){1,2}$/.test(key)) err(`${def.file}: ключ ${key} — ожидается <категория>.<объект>[.<действие>] в snake_case`);
  if (!def.category) err(`${def.file}: у ${key} не найдена category`);
  else {
    if (!CATEGORIES.has(def.category)) err(`${def.file}: у ${key} неизвестная категория '${def.category}'`);
    if (def.category !== categoryOf(key)) err(`${def.file}: у ${key} category '${def.category}' ≠ префиксу ключа '${categoryOf(key)}'`);
  }
  if (!def.vis) err(`${def.file}: у ${key} visibility не из пресетов AUDIT_VIS — платформа обязана видеть всё`);
  if (def.category === 'platform' && def.vis !== 'platform') err(`${def.file}: ${key} — действия сотрудников платформы людям и организациям не показываются (только AUDIT_VIS.platform)`);
  if (def.windowExempt && def.category !== 'pd' && def.category !== 'consents') err(`${def.file}: у ${key} windowExempt — только для pd.* и consents.*`);
  for (const d of def.details) {
    const bad = words(d).find((w) => DENY.has(w));
    if (bad) err(`${def.file}: деталь ${key}.${d} содержит запрещённое слово «${bad}» — ПДн, секреты и свободный текст в журнал не пишутся`);
  }
}

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
  const file = path.join(MESSAGES, locale, 'audit.json');
  if (!fs.existsSync(file)) {
    err(`нет каталога messages/${locale}/audit.json`);
    continue;
  }
  let flat;
  try {
    flat = flatten(JSON.parse(read(file)), '', new Set());
  } catch (e) {
    err(`messages/${locale}/audit.json не разбирается: ${e.message}`);
    continue;
  }
  const missing = [];
  for (const key of registry.keys()) for (const part of ['title', 'body']) if (!flat.has(`events.${key}.${part}`)) missing.push(`events.${key}.${part}`);
  for (const cat of CATEGORIES) if (!flat.has(`categories.${cat}`)) missing.push(`categories.${cat}`);
  if (missing.length) err(`messages/${locale}/audit.json — нет ${missing.length} ключей:\n    ${missing.join('\n    ')}`);
  const orphans = [...flat]
    .filter((k) => k.startsWith('events.'))
    .map((k) => k.replace(/^events\./, '').replace(/\.(title|body)$/, ''))
    .filter((k, i, a) => a.indexOf(k) === i && !registry.has(k));
  if (orphans.length) err(`messages/${locale}/audit.json — события вне реестра: ${orphans.join(', ')}`);
}

// ---------- запись: живые ключи пишутся, planned — нет, чужих ключей в вызовах нет ----------
function walk(dir, files) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.(ts|cjs|js)$/.test(e.name)) files.push(p);
  }
  return files;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const apiFiles = [...walk(API_DIR, []), ...walk(API_SCRIPTS, []).filter((f) => !/verify-/.test(path.basename(f)))].map((f) => ({ f, txt: read(f) }));
// Записью считается литерал ключа в файле, который ходит в движок журнала: одноимённый тип
// уведомления (`auth.password.changed`) в файле без журнала — не запись события
const AUDIT_USE = /\bAuditService\b|\baudit\.(?:record|recordBatch|recordOnce)\s*\(|AUDIT_KEY_OF|\bauditKeyFor\w*\b/;
const auditFiles = apiFiles.filter(({ f, txt }) => AUDIT_USE.test(txt) && !f.includes(`${path.sep}core${path.sep}audit${path.sep}audit.registry`));
for (const [key, def] of registry) {
  const re = new RegExp(`['"\`]${escapeRe(key)}['"\`]`);
  const sent = auditFiles.some(({ txt }) => re.test(txt));
  if (def.status === 'planned' && sent) err(`${def.file}: ключ ${key} помечен planned, но уже пишется — переведите в live`);
  if (def.status !== 'planned' && !sent) err(`${def.file}: у живого ключа ${key} нет записи в apps/api/src — событие не придёт никогда: пометьте planned или удалите`);
}
// Литерал ключа в вызове движка (`key: '<x.y>'` в объекте записи) обязан быть в реестре
for (const { f, txt } of apiFiles) {
  if (!/\baudit\b/i.test(txt)) continue;
  for (const m of txt.matchAll(/\b(?:record|recordBatch|recordOnce)\s*\(\s*[\w.$]+\s*,\s*\{[^}]*?\bkey:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) {
    if (!registry.has(m[1])) err(`${path.relative(ROOT, f)}: запись ключа ${m[1]}, которого нет в реестре packages/shared/src/audit`);
  }
}

if (errors) {
  console.error(`check-audit: ${errors} ошибок, ${warnings} предупреждений`);
  process.exit(1);
}
console.log(`check-audit: ok — ${registry.size} событий, ${CATEGORIES.size} категорий${warnings ? `, ${warnings} предупреждений` : ''}`);
