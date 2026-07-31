#!/usr/bin/env node
/* eslint-disable no-console */
// ============================================================
// Сборка пака значков SuperApp6.
//
// На входе — четыре внешних источника (пины в pins.env), на выходе — статика
// в apps/web/public/glyphs/ и один сгенерированный CSS со шрифтом:
//
//   fluent/<кодпоинт>.webp   картинки эмодзи «Свои» (Fluent Color, 128px)
//   font/*.woff2             сабсеты Noto Color Emoji + текст лицензии OFL
//   icons.json               контуры предметных иконок { имя: path d }
//   index.json               каталог для поиска (эмодзи + иконки, по-русски)
//   apps/web/src/app/noto-emoji.css   @font-face с unicode-range на наши файлы
//
// Запуск — из PowerShell через build.ps1 (конвенция репозитория), либо прямо:
//   node infra/glyph-pack/build.cjs [--skip-fetch] [--force] [--only emoji|icons|font]
//
// ЗАЧЕМ КАРТИНКИ, А НЕ SVG: исходные Color-SVG весят в среднем 25 КБ (градиенты
// и фильтры), весь пак — 38 МБ, и один экран сетки выбора тянул бы полтора
// мегабайта. После растеризации 128px/webp значок весит 2–3 КБ, пак ~4 МБ.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const WORK = path.join(HERE, 'work');
const OUT = path.join(REPO, 'apps', 'web', 'public', 'glyphs');
const CSS_OUT = path.join(REPO, 'apps', 'web', 'src', 'app', 'noto-emoji.css');

const args = process.argv.slice(2);
const SKIP_FETCH = args.includes('--skip-fetch');
const FORCE = args.includes('--force');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? args[i + 1] : null;
})();
const want = (part) => !ONLY || ONLY === part;

// Русские подписи групп эмодзи. Свои, а не из emojibase: там они дословные и
// местами странные («тело людей», «варианты досуга»).
const EMOJI_GROUP_LABELS = {
  'smileys-emotion': 'Смайлики',
  'people-body': 'Люди и жесты',
  'animals-nature': 'Животные и природа',
  'food-drink': 'Еда и напитки',
  'travel-places': 'Путешествия и места',
  activities: 'Досуг',
  objects: 'Предметы',
  symbols: 'Символы',
  flags: 'Флаги',
};

// ---------- мелкие утилиты ----------

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error('\n[glyph-pack] ОШИБКА: ' + msg + '\n');
  process.exit(1);
};

function readPins() {
  const pins = {};
  for (const line of fs.readFileSync(path.join(HERE, 'pins.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) pins[m[1]] = m[2].trim();
  }
  return pins;
}

function run(cmd, cmdArgs, cwd, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

// npm на Windows — это npm.cmd, а Node с 18.20 отказывается запускать .cmd/.bat
// без shell (закрытая дыра с подстановкой аргументов). Аргументы у нас без
// пробелов, поэтому shell здесь безопасен.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmRun = (cmdArgs, cwd) => run(NPM, cmdArgs, cwd, process.platform === 'win32' ? { shell: true } : {});

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Достаёт npm-пакет в work/<имя папки> (идемпотентно). */
function fetchNpm(spec, dirName) {
  const dest = path.join(WORK, dirName);
  if (fs.existsSync(dest) && !FORCE) {
    log(`  · ${spec} — уже скачан`);
    return dest;
  }
  ensureDir(WORK);
  log(`  · качаю ${spec}…`);
  const out = npmRun(['pack', spec, '--silent'], WORK).trim().split(/\r?\n/).pop();
  const tgz = path.join(WORK, out);
  fs.rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  run('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], WORK);
  return dest;
}

/**
 * Клонирует ТОЛЬКО нужные файлы Fluent на пиненом коммите.
 * Полный репозиторий — полтора гигабайта (четыре стиля × шесть тонов кожи);
 * blob-фильтр + sparse-checkout тянут ~44 МБ.
 */
function fetchFluent(pins) {
  const dest = path.join(WORK, 'fluent');
  const head = path.join(dest, '.git', 'HEAD');
  if (fs.existsSync(head) && !FORCE) {
    const cur = run('git', ['rev-parse', 'HEAD'], dest).trim();
    if (cur === pins.FLUENT_COMMIT) {
      log('  · fluent — уже на нужном коммите');
      return dest;
    }
  }
  ensureDir(dest);
  log('  · клонирую Fluent Emoji (только Color, ~44 МБ)…');
  if (!fs.existsSync(path.join(dest, '.git'))) {
    run('git', ['init', '-q'], dest);
    run('git', ['remote', 'add', 'origin', pins.FLUENT_REPO], dest);
  }
  run('git', ['sparse-checkout', 'init', '--no-cone'], dest);
  run('git', ['sparse-checkout', 'set',
    '/assets/*/metadata.json',
    '/assets/*/Color/*.svg',
    '/assets/*/Default/Color/*.svg',
  ], dest);
  run('git', ['fetch', '--filter=blob:none', '--depth', '1', 'origin', pins.FLUENT_COMMIT], dest);
  run('git', ['checkout', '-q', 'FETCH_HEAD'], dest);
  return dest;
}

/** Кодпоинты к единому виду: строчные, через дефис, без селектора представления. */
const normHex = (s) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');
const stripVs = (s) => s.split('-').filter((p) => p !== 'fe0f' && p !== 'fe0e').join('-');

// ---------- эмодзи ----------

async function buildEmoji(pins, fluentDir, ebDir) {
  const sharpPath = path.join(REPO, 'apps', 'api', 'node_modules', 'sharp');
  if (!fs.existsSync(sharpPath)) {
    die('нет apps/api/node_modules/sharp — выполните pnpm install (растеризация идёт им же, чем конвейер файлов)');
  }
  const sharp = require(sharpPath);

  const data = JSON.parse(fs.readFileSync(path.join(ebDir, 'ru', 'data.json'), 'utf8'));
  const messages = JSON.parse(fs.readFileSync(path.join(ebDir, 'ru', 'messages.json'), 'utf8'));

  // Карта «кодпоинт → файл Color-SVG». Ключ нормализован без FE0F: у Fluent и у
  // CLDR селектор представления проставлен по-разному, и без этого треть пака
  // не находилась бы.
  const fluentByHex = new Map();
  const assetsRoot = path.join(fluentDir, 'assets');
  for (const dir of fs.readdirSync(assetsRoot)) {
    const metaPath = path.join(assetsRoot, dir, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    const candidates = [path.join(assetsRoot, dir, 'Color'), path.join(assetsRoot, dir, 'Default', 'Color')];
    let svg = null;
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const f = fs.readdirSync(c).find((x) => x.endsWith('.svg'));
      if (f) { svg = path.join(c, f); break; }
    }
    if (!svg || !meta.unicode) continue;
    fluentByHex.set(stripVs(normHex(meta.unicode)), svg);
  }
  log(`  · Fluent: ${fluentByHex.size} значков`);

  const groupKeys = (messages.groups || []).slice().sort((a, b) => a.order - b.order).map((g) => g.key);
  // Группа «component» — это модификаторы (тона кожи, тип волос), самостоятельными
  // значками они не бывают; в выборе им делать нечего.
  const usedGroups = groupKeys.filter((k) => k !== 'component');
  const groupIndex = new Map(usedGroups.map((k, i) => [k, i]));
  const groupKeyByNumber = new Map((messages.groups || []).map((g) => [g.order, g.key]));

  const outDir = path.join(OUT, 'fluent');
  ensureDir(outDir);

  const entries = [];
  const jobs = [];
  for (const e of data) {
    const gKey = groupKeyByNumber.get(e.group);
    if (!gKey || !groupIndex.has(gKey)) continue;
    const hex = normHex(e.hexcode);
    const svg = fluentByHex.get(stripVs(hex));
    const tags = (e.tags || []).filter((t) => t && t !== e.label).join(' ');
    entries.push([hex, e.emoji, e.label, tags, groupIndex.get(gKey), svg ? 1 : 0, e.order ?? 0]);
    if (svg) jobs.push({ hex, svg });
  }
  entries.sort((a, b) => a[6] - b[6]);

  // Растеризация пулом: sharp освобождает поток на время работы libvips,
  // но 1600 задач разом съедают память — держим окно в 8.
  const px = Number(pins.EMOJI_PX || 128);
  const quality = Number(pins.EMOJI_WEBP_QUALITY || 88);
  let done = 0;
  let written = 0;
  const pool = 8;
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const dest = path.join(outDir, `${job.hex}.webp`);
      if (!FORCE && fs.existsSync(dest)) { done++; continue; }
      // density: SVG у Fluent — 32×32, при стандартных 72 dpi он и растеризуется
      // в 32px. Берём с запасом и уменьшаем до целевого — так края чище.
      await sharp(job.svg, { density: 600 })
        .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality, alphaQuality: 100, effort: 4 })
        .toFile(dest);
      written++;
      done++;
      if (done % 200 === 0) log(`    …${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: pool }, worker));
  log(`  · растеризовано: ${written} новых, всего ${jobs.length}`);

  // Прибрать значки, выпавшие из пака при смене пинов, — иначе в public/ вечно
  // копится мусор от прошлых версий.
  const alive = new Set(jobs.map((j) => `${j.hex}.webp`));
  let removed = 0;
  for (const f of fs.readdirSync(outDir)) {
    if (!alive.has(f)) { fs.unlinkSync(path.join(outDir, f)); removed++; }
  }
  if (removed) log(`  · убрано устаревших: ${removed}`);

  return {
    groups: usedGroups.map((k) => ({ k, l: EMOJI_GROUP_LABELS[k] || k })),
    emoji: entries.map((e) => e.slice(0, 6)),
    covered: jobs.length,
  };
}

// ---------- иконки ----------

function buildIcons(phosphorDir) {
  const lightDir = path.join(phosphorDir, 'assets', 'light');
  if (!fs.existsSync(lightDir)) die('в пакете Phosphor нет assets/light');
  const available = new Set(fs.readdirSync(lightDir).map((f) => f.replace(/-light\.svg$/, '')));

  const catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'icons.catalog.json'), 'utf8'));
  const paths = {};
  const groups = [];
  const icons = [];
  const missing = [];

  const seen = new Map();
  catalog.groups.forEach((g, gi) => {
    groups.push({ k: g.key, l: g.label });
    for (const [name, label, tags] of g.icons) {
      // Дубль имени в каталоге — не косметика: одна и та же иконка попадёт в
      // выдачу дважды с ОДИНАКОВЫМ значением, а значит и с одинаковым ключом
      // React в сетке выбора.
      if (seen.has(name)) { missing.push(`${g.key}/${name} (уже есть в группе «${seen.get(name)}»)`); continue; }
      seen.set(name, g.key);
      if (!available.has(name)) { missing.push(`${g.key}/${name}`); continue; }
      const svg = fs.readFileSync(path.join(lightDir, `${name}-light.svg`), 'utf8');
      const m = svg.match(/<path\s+d="([^"]+)"/);
      if (!m) { missing.push(`${g.key}/${name} (нет <path d=…>)`); continue; }
      // Все 1512 иконок Light — ровно один путь в системе координат 0 0 256 256.
      // На этом держится рендер: клиенту достаточно строки d, ни SVG-файлов,
      // ни спрайта, ни внешнего <use> не нужно.
      if ((svg.match(/<path/g) || []).length !== 1) { missing.push(`${g.key}/${name} (путей больше одного)`); continue; }
      paths[name] = m[1];
      icons.push([name, label, tags || '', gi]);
    }
  });

  if (missing.length) {
    die('в каталоге есть имена, которых нет в Phosphor Light (правьте icons.catalog.json):\n  ' + missing.join('\n  '));
  }

  ensureDir(OUT);
  fs.writeFileSync(path.join(OUT, 'icons.json'), JSON.stringify(paths));
  log(`  · иконок: ${icons.length} в ${groups.length} группах`);
  return { groups, icons };
}

// ---------- шрифт ----------

const FONT_FILE = 'noto-color-emoji-colrv1.woff2';

/** Скачивание с проверкой содержимого (пины — по sha256, а не по «последнему»). */
async function download(url, dest, expectSha) {
  if (fs.existsSync(dest) && !FORCE) {
    const cur = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (!expectSha || cur === expectSha) return fs.readFileSync(dest);
  }
  log(`  · качаю ${url.split('/').pop()}…`);
  const res = await fetch(url);
  if (!res.ok) die(`не скачался ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (expectSha && sha !== expectSha) {
    die(`sha256 не совпал у ${url}\n  ожидали ${expectSha}\n  получили ${sha}\n  (upstream подменили — проверьте и обновите pins.env осознанно)`);
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  return buf;
}

async function buildFont(pins) {
  const fontOut = path.join(OUT, 'font');
  ensureDir(fontOut);
  const workDir = path.join(WORK, 'noto');

  const base = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${pins.NOTO_REPO_COMMIT}`;
  const ttf = await download(`${base}/${pins.NOTO_TTF_PATH}`, path.join(workDir, 'Noto-COLRv1.ttf'), pins.NOTO_TTF_SHA256);
  // OFL требует, чтобы текст лицензии сопровождал шрифт.
  await download(`${base}/fonts/LICENSE`, path.join(fontOut, 'OFL.txt'));

  const dest = path.join(fontOut, FONT_FILE);
  if (!fs.existsSync(dest) || FORCE) {
    const wa = fetchNpm(pins.WOFF2_PKG, 'wawoff2');
    log('  · жму в woff2 (~15 с)…');
    const { compress } = require(path.join(wa, 'index.js'));
    fs.writeFileSync(dest, Buffer.from(await compress(ttf)));
  }

  // Прибрать файлы прошлых сборок (были нарезанные сабсеты fontsource).
  for (const f of fs.readdirSync(fontOut)) {
    if (f.endsWith('.woff2') && f !== FONT_FILE) fs.unlinkSync(path.join(fontOut, f));
  }

  const header = `/* СГЕНЕРИРОВАНО infra/glyph-pack/build.cjs — руками не править.
   Noto Color Emoji (Google, OFL-1.1), официальная векторная сборка COLRv1.
   Подключается из globals.css; в шрифтовом стеке стоит ПОСЛЕ Manrope, иначе
   цифры и решётку (они есть в эмодзи-шрифте) рисовал бы он.
   Файл один и без unicode-range: нарезка от fontsource в Chromium рисовала
   ПУСТОТУ — глиф в сабсете есть, поэтому браузер даже не откатывался на
   системный шрифт, и вкладка эмодзи выглядела пустой. */\n\n`;
  fs.writeFileSync(CSS_OUT, `${header}@font-face {
  font-family: 'Noto Color Emoji';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/glyphs/font/${FONT_FILE}') format('woff2');
}
`);

  log(`  · шрифт: ${(fs.statSync(dest).size / 1048576).toFixed(2)} МБ (COLRv1, один файл)`);
}

// ---------- точка входа ----------

(async () => {
  const pins = readPins();
  ensureDir(OUT);
  log('[glyph-pack] сборка пака значков');

  let fluentDir; let ebDir; let phosphorDir;
  if (!SKIP_FETCH) {
    log('· источники');
    if (want('emoji')) { fluentDir = fetchFluent(pins); ebDir = fetchNpm(pins.EMOJIBASE_PKG, 'emojibase'); }
    if (want('icons')) phosphorDir = fetchNpm(pins.PHOSPHOR_PKG, 'phosphor');
  } else {
    fluentDir = path.join(WORK, 'fluent');
    ebDir = path.join(WORK, 'emojibase');
    phosphorDir = path.join(WORK, 'phosphor');
  }

  const indexPath = path.join(OUT, 'index.json');
  const prev = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;

  let emoji = prev ? { groups: prev.emojiGroups, emoji: prev.emoji, covered: prev.meta?.fluentCovered ?? 0 } : null;
  let icons = prev ? { groups: prev.iconGroups, icons: prev.icons } : null;

  if (want('emoji')) { log('· эмодзи'); emoji = await buildEmoji(pins, fluentDir, ebDir); }
  if (want('icons')) { log('· иконки'); icons = buildIcons(phosphorDir); }
  if (want('font')) { log('· шрифт'); await buildFont(pins); }

  if (!emoji || !icons) die('нечего писать в index.json — соберите хотя бы раз без --only');

  fs.writeFileSync(indexPath, JSON.stringify({
    v: 1,
    meta: {
      fluentCommit: pins.FLUENT_COMMIT,
      phosphor: pins.PHOSPHOR_PKG,
      emojibase: pins.EMOJIBASE_PKG,
      noto: `noto-emoji@${pins.NOTO_REPO_COMMIT.slice(0, 8)}`,
      emojiPx: Number(pins.EMOJI_PX || 128),
      fluentCovered: emoji.covered,
    },
    emojiGroups: emoji.groups,
    emoji: emoji.emoji,
    iconGroups: icons.groups,
    icons: icons.icons,
  }));

  const idxKb = (fs.statSync(indexPath).size / 1024).toFixed(0);
  log(`\n[glyph-pack] готово: ${emoji.emoji.length} эмодзи (${emoji.covered} с картинкой Fluent), ${icons.icons.length} иконок, каталог ${idxKb} КБ`);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
