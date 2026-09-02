#!/usr/bin/env node
/**
 * Страж документации — механическая сверка docs/ и корневых инструкций с кодом.
 *
 * Зачем: доки правит человек или агент по памяти, и за месяц они разошлись с кодом
 * в ~70 местах (аудит 2026-09-02) — включая пропущенное правило безопасности файлов.
 * Скрипт превращает документацию из обещания в проверяемый факт: без LLM, без токенов,
 * секунды на прогон. Гоняется шагом CI и руками перед коммитом:
 *
 *   node scripts/check-docs.cjs            # проверить (код выхода 1 при ошибках)
 *   node scripts/check-docs.cjs --write    # перегенерировать docs/module_graph_edges.md
 *   node scripts/check-docs.cjs --since <git-ref>   # + предупреждения «тронул модуль, не тронул док»
 *
 * Проверки (ошибка = падение сборки, предупреждение = только вывод):
 *   paths  — каждый путь вида apps/… packages/… infra/… docs/… в доках существует;
 *            относительные ссылки [x](y.md) внутри docs/ ведут на живые файлы.
 *   index  — каждый docs/*.md есть в docs/README.md; каждый каталог core/* и modules/*
 *            упомянут хотя бы одним доком как `core/<имя>` / `modules/<имя>`.
 *   env    — переменная, читаемая в коде API, стоит в zod-схеме; всё из схемы и все
 *            NEXT_PUBLIC_* веба описаны в docs/environment_variables.md; .env.example
 *            не содержит неизвестных схеме ключей.
 *   graph  — таблица синхронных рёбер модулей генерируется из импортов и DI-токенов
 *            (docs/module_graph_edges.md) и обязана совпадать с закоммиченной; новое
 *            ребро core/* → modules/* вне списка записанного долга — ошибка.
 *   size   — предупреждение, если док перерос 15 КБ (правило docs/README.md).
 *   touch  — (только с --since) предупреждение, если изменён код модуля, а ни один док,
 *            упоминающий этот модуль, не тронут.
 *
 * Пути и допущения — в константах ниже; менять их — вместе с docs/testing_verify_suite.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const API_SRC = path.join(ROOT, 'apps', 'api', 'src');
const MODULE_ROOTS = ['core', 'modules'];
const ENV_SCHEMA = path.join(API_SRC, 'shared', 'config', 'env.validation.ts');
const ENV_DOC = path.join(DOCS_DIR, 'environment_variables.md');
const ENV_EXAMPLE_API = path.join(ROOT, 'apps', 'api', '.env.example');
const ENV_EXAMPLE_WEB = path.join(ROOT, 'apps', 'web', '.env.example');
const WEB_SRC = path.join(ROOT, 'apps', 'web', 'src');
const WEB_NEXT_CONFIG = path.join(ROOT, 'apps', 'web', 'next.config.ts');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const EDGES_DOC = path.join(DOCS_DIR, 'module_graph_edges.md');
const DOC_SIZE_WARN = 15 * 1024;
/** Статусные документы с чек-боксами живут по своим правилам размера. */
const DOC_SIZE_EXEMPT = new Set(['gap_analysis_v2.md']);

/**
 * Записанный долг границ движков (docs/roadmap.md, «Границы движков»; docs/module_graph.md §4).
 * Любое ДРУГОЕ ребро core/* → modules/* — ошибка: правило «движки не импортируют фичи».
 * Закрыл долг — убери строку отсюда, иначе страж не заметит возврата нарушения.
 */
const KNOWN_CORE_TO_MODULES = new Set([
  'core/approvals → modules/notifications',
  'core/auth → modules/notifications',
  'core/calls → modules/notifications',
  'core/files → modules/notifications',
  'core/share-links → modules/notifications',
  'core/sign → modules/notifications',
  'core/users → modules/notifications',
  'core/users → modules/contacts',
  'core/users → modules/workspaces',
  // rich-cards постит карточку в чат ленивым токеном MessengerService — чат как канал доставки,
  // та же природа, что и уведомления; решается вместе с core/notifications.
  'core/rich-cards → modules/messenger',
]);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const GH = !!process.env.GITHUB_ACTIONS;

const errors = [];
const warnings = [];
const err = (check, msg) => errors.push(`[${check}] ${msg}`);
const warn = (check, msg) => warnings.push(`[${check}] ${msg}`);

// ---------- утилиты ----------
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

function walk(dir, pred, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

const listDocs = () =>
  fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(DOCS_DIR, f));

const rootDocs = () =>
  ['CLAUDE.md', 'PRODUCT.md', 'DESIGN.md'].map((f) => path.join(ROOT, f)).filter(exists);

const listModules = () => {
  const out = [];
  for (const r of MODULE_ROOTS) {
    const dir = path.join(API_SRC, r);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) out.push(`${r}/${e.name}`);
  }
  return out.sort();
};

// ---------- paths ----------
function checkPaths() {
  const re = /(?:^|[\s`'"(\[])((?:apps|packages|infra|docs|scripts|\.claude|\.serena|\.github)\/[A-Za-z0-9_\-./\[\]@]+)/g;
  for (const doc of [...rootDocs(), ...listDocs()]) {
    const txt = read(doc);
    const seen = new Set();
    let m;
    while ((m = re.exec(txt))) {
      const p = m[1].replace(/[.,:;)\]`'"]+$/, '');
      if (/[<>*{}…]/.test(p) || p.endsWith('-') || p.endsWith('/')) continue; // шаблоны вида verify-<name>
      if (seen.has(p)) continue;
      seen.add(p);
      if (!exists(path.join(ROOT, p))) err('paths', `${rel(doc)}: путь не существует — ${p}`);
    }
    if (doc.startsWith(DOCS_DIR)) {
      const linkRe = /\]\(([^)#\s]+\.md)(#[^)]*)?\)/g;
      while ((m = linkRe.exec(txt))) {
        const t = m[1];
        if (/^https?:/.test(t)) continue;
        if (!exists(path.resolve(path.dirname(doc), t))) err('paths', `${rel(doc)}: битая ссылка — ${t}`);
      }
    }
  }
}

// ---------- index ----------
function checkIndex() {
  const readme = read(path.join(DOCS_DIR, 'README.md'));
  const linked = new Set([...readme.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((m) => m[1]));
  for (const doc of listDocs()) {
    const name = path.basename(doc);
    if (name === 'README.md') continue;
    if (!linked.has(name)) err('index', `docs/${name} не упомянут в docs/README.md`);
  }
  const corpus = listDocs()
    .map(read)
    .join('\n');
  for (const mod of listModules()) {
    if (!corpus.includes(mod)) err('index', `apps/api/src/${mod}/ не упомянут ни одним доком как \`${mod}\``);
  }
}

// ---------- env ----------
function envKeysIn(text, re) {
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
}
/** Как envKeysIn, но пропускает совпадения в строках-комментариях (`// process.env.X` в описаниях). */
function envKeysInCode(text, re) {
  const out = new Set();
  let m;
  while ((m = re.exec(text))) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const prefix = text.slice(lineStart, m.index).trimStart();
    if (prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')) continue;
    out.add(m[1]);
  }
  return out;
}
function checkEnv() {
  const apiFiles = walk(API_SRC, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'));
  const codeApi = new Set();
  for (const f of apiFiles) for (const k of envKeysInCode(read(f), /process\.env\.([A-Z][A-Z0-9_]*)/g)) codeApi.add(k);

  const webFiles = [...walk(WEB_SRC, (p) => /\.(ts|tsx)$/.test(p)), WEB_NEXT_CONFIG].filter(exists);
  const codeWeb = new Set();
  for (const f of webFiles) for (const k of envKeysIn(read(f), /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]*)/g)) codeWeb.add(k);

  const schemaTxt = read(ENV_SCHEMA);
  const schema = envKeysIn(schemaTxt, /^\s{2,}([A-Z][A-Z0-9_]*):\s/gm);
  const docKeys = envKeysIn(read(ENV_DOC), /`([A-Z][A-Z0-9_]{2,})`/g);
  const exampleApi = exists(ENV_EXAMPLE_API) ? envKeysIn(read(ENV_EXAMPLE_API), /^#?\s*([A-Z][A-Z0-9_]*)=/gm) : new Set();
  const exampleWeb = exists(ENV_EXAMPLE_WEB) ? envKeysIn(read(ENV_EXAMPLE_WEB), /^#?\s*([A-Z][A-Z0-9_]*)=/gm) : new Set();
  const composeTxt = exists(COMPOSE) ? read(COMPOSE) : '';
  const compose = new Set([
    ...envKeysIn(composeTxt, /\$\{([A-Z][A-Z0-9_]*)/g),
    ...envKeysIn(composeTxt, /^\s+-?\s*([A-Z][A-Z0-9_]{2,})[=:]/gm),
  ]);

  for (const k of codeApi) if (!schema.has(k)) err('env', `${k} читается в apps/api/src, но отсутствует в zod-схеме ${rel(ENV_SCHEMA)}`);
  for (const k of schema) if (!docKeys.has(k)) err('env', `${k} есть в zod-схеме, но не описана в ${rel(ENV_DOC)}`);
  for (const k of codeWeb) if (!docKeys.has(k)) err('env', `${k} читается в apps/web, но не описана в ${rel(ENV_DOC)}`);
  for (const k of exampleApi) if (!schema.has(k)) err('env', `${k} стоит в apps/api/.env.example, но неизвестна zod-схеме`);
  for (const k of exampleWeb) if (!codeWeb.has(k)) err('env', `${k} стоит в apps/web/.env.example, но не читается в apps/web`);
  for (const k of schema) if (!exampleApi.has(k)) warn('env', `${k} есть в схеме, но нет в apps/api/.env.example`);
  const known = new Set([...schema, ...codeWeb, ...compose, ...codeApi]);
  for (const k of docKeys) if (!known.has(k) && !/^(NODE_ENV|CI)$/.test(k)) warn('env', `${k} описана в доке, но не читается ни кодом, ни compose (устарела?)`);
}

// ---------- graph ----------
function moduleOf(absFile) {
  const r = path.relative(API_SRC, absFile).split(path.sep).join('/');
  const m = /^(core|modules)\/([^/]+)\//.exec(r);
  return m ? `${m[1]}/${m[2]}` : null;
}
function buildEdges() {
  // Класс <Name>Service объявлен в каком модуле → карта DI-токенов без ручного списка.
  const tokenFile = path.join(API_SRC, 'shared', 'di-tokens.ts');
  const tokenNames = [...read(tokenFile).matchAll(/^\s+([A-Za-z]+Service):\s*'/gm)].map((m) => m[1]);
  const tsFiles = walk(API_SRC, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.spec.ts'));
  const classHome = new Map();
  for (const f of tsFiles) {
    const mod = moduleOf(f);
    if (!mod) continue;
    for (const m of read(f).matchAll(/export\s+class\s+([A-Za-z]+Service)\b/g)) classHome.set(m[1], mod);
  }
  const tokenHome = new Map();
  for (const t of tokenNames) {
    if (!classHome.has(t)) err('graph', `DI-токен ${t}: класс не найден ни в core/*, ни в modules/*`);
    else tokenHome.set(t, classHome.get(t));
  }

  const edges = new Map(); // "src → dst" -> Set(kind)
  const add = (src, dst, kind) => {
    if (!src || !dst || src === dst) return;
    const key = `${src} → ${dst}`;
    if (!edges.has(key)) edges.set(key, new Set());
    edges.get(key).add(kind);
  };
  const importRe = /^\s*import\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const f of tsFiles) {
    const src = moduleOf(f);
    if (!src) continue;
    const txt = read(f);
    let m;
    while ((m = importRe.exec(txt))) {
      if (m[1]) continue; // import type — не runtime-ребро
      let spec = m[2];
      if (spec.startsWith('@/')) spec = path.join(API_SRC, spec.slice(2));
      else if (spec.startsWith('.')) spec = path.resolve(path.dirname(f), spec);
      else continue; // пакеты
      add(src, moduleOf(spec + '.ts'), 'import');
    }
    for (const t of txt.matchAll(/DI_TOKENS\.([A-Za-z]+Service)\b/g)) {
      // Регистрация своего токена (`provide: DI_TOKENS.X`) — не ребро.
      const dst = tokenHome.get(t[1]);
      if (dst && dst !== src) add(src, dst, 'token');
    }
  }
  return edges;
}
function renderEdges(edges) {
  const bySrc = new Map();
  for (const [key, kinds] of edges) {
    const [src, dst] = key.split(' → ');
    if (!bySrc.has(src)) bySrc.set(src, []);
    bySrc.get(src).push(kinds.has('import') ? dst : `${dst} (токен)`);
  }
  const lines = [
    '# Синхронные рёбра модулей (генерируется)',
    '',
    '> СГЕНЕРИРОВАНО скриптом `scripts/check-docs.cjs --write` из импортов и DI-токенов `apps/api/src`; руками не править. Смысл рёбер и правила — [module_graph.md](module_graph.md) и [module_graph_documents.md](module_graph_documents.md). Ребро = модуль-потребитель импортирует что-либо из каталога другого модуля (кроме `import type`) или зовёт его ленивым `DI_TOKENS` (помечено «токен»).',
    '',
    '| Потребитель | Зависит от |',
    '|---|---|',
  ];
  for (const src of [...bySrc.keys()].sort()) lines.push(`| \`${src}\` | ${bySrc.get(src).sort().map((d) => `\`${d}\``).join(', ')} |`);
  lines.push('');
  return lines.join('\n');
}
function checkGraph() {
  const edges = buildEdges();
  for (const key of edges.keys()) {
    if (key.startsWith('core/') && key.includes('→ modules/') && !KNOWN_CORE_TO_MODULES.has(key)) {
      err('graph', `новое ребро движок → фича: ${key} (правило docs/module_graph.md §4; долг записывается в roadmap и в KNOWN_CORE_TO_MODULES скрипта)`);
    }
  }
  for (const key of KNOWN_CORE_TO_MODULES) {
    if (!edges.has(key)) warn('graph', `долг ${key} в коде больше не найден — закройте его в roadmap/module_graph.md и уберите из KNOWN_CORE_TO_MODULES`);
  }
  const rendered = renderEdges(edges);
  const current = exists(EDGES_DOC) ? read(EDGES_DOC).replace(/\r\n/g, '\n') : null;
  if (WRITE) {
    fs.writeFileSync(EDGES_DOC, rendered, 'utf8');
    console.log(`[graph] записан ${rel(EDGES_DOC)} (${edges.size} рёбер)`);
  } else if (current !== rendered) {
    err('graph', `${rel(EDGES_DOC)} не совпадает с кодом — выполните \`node scripts/check-docs.cjs --write\` и закоммитьте`);
  }
}

// ---------- size ----------
function checkSize() {
  for (const doc of listDocs()) {
    const name = path.basename(doc);
    if (DOC_SIZE_EXEMPT.has(name)) continue;
    const size = fs.statSync(doc).size;
    if (size > DOC_SIZE_WARN) warn('size', `docs/${name}: ${(size / 1024).toFixed(1)} КБ > 15 КБ — тему пора делить (docs/README.md)`);
  }
}

// ---------- touch ----------
function checkTouch() {
  if (!SINCE) return;
  let changed;
  try {
    changed = execSync(`git diff --name-only ${SINCE} HEAD`, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    warn('touch', `git diff ${SINCE} HEAD не выполнился: ${String(e.message).split('\n')[0]}`);
    return;
  }
  const touchedMods = new Set();
  for (const f of changed) {
    const m = /^apps\/api\/src\/(core|modules)\/([^/]+)\//.exec(f);
    if (m) touchedMods.add(`${m[1]}/${m[2]}`);
  }
  if (!touchedMods.size) return;
  const changedDocs = changed.filter((f) => /^(docs\/.*\.md|CLAUDE\.md)$/.test(f) && exists(path.join(ROOT, f)));
  const docCorpus = changedDocs.map((f) => read(path.join(ROOT, f))).join('\n');
  for (const mod of touchedMods) {
    if (!docCorpus.includes(mod)) warn('touch', `изменён apps/api/src/${mod}/, но ни один изменённый док не упоминает \`${mod}\` — проверьте, не отстала ли документация`);
  }
}

// ---------- запуск ----------
checkPaths();
checkIndex();
checkEnv();
checkGraph();
checkSize();
checkTouch();

for (const w of warnings) console.log(GH ? `::warning::${w}` : `WARN  ${w}`);
for (const e of errors) console.log(GH ? `::error::${e}` : `ERROR ${e}`);
console.log(`\ncheck-docs: ${errors.length} ошибок, ${warnings.length} предупреждений`);
process.exit(errors.length ? 1 : 0);
