#!/usr/bin/env node
'use strict';

// ============================================================
// МЕХАНИЧЕСКИЙ СТРАЖ КАТАЛОГОВ (`pnpm check:i18n`).
//
// Что он держит — то, что глазами не удержать:
//   1. у каждого неймспейса есть файл в КАЖДОЙ локали;
//   2. набор ключей en ⇔ kk ⇔ ru совпадает ПОЛНОСТЬЮ (лишние и пропущенные —
//      ошибка, а не «потом переведём»: молча пропущенный ключ показывает
//      человеку сам ключ);
//   3. каждое сообщение разбирается ICU-парсером (кривая plural-скобка ломает
//      фразу только в рантайме и только на одном языке);
//   4. плейсхолдеры и ветки plural/select совпадают между локалями (переводчик
//      потерял `{name}` — фраза станет безымянной);
//   5. `messages/index.ts` соответствует файлам на диске (генератор запускали);
//   6. ПРЕДУПРЕЖДЕНИЯ: слишком большой неймспейс и ключ, которого нет в коде.
//
// Ратчет (`i18n.legacy.json`) стережёт САМО правило ESLint — там ему место:
// оно уже разбирает каждый файл, и вторая реализация «что считать кириллицей»
// немедленно разъехалась бы с первой.
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@formatjs/icu-messageformat-parser');

const ROOT = path.join(__dirname, '..');
const I18N = path.join(ROOT, 'packages', 'i18n');
const MSG = path.join(I18N, 'src', 'messages');

/** Порог «неймспейс пора делить» — он целиком едет в браузер на своих страницах. */
const NAMESPACE_SIZE_WARN = 40 * 1024;

/**
 * СЕРВЕРНЫЕ неймспейсы: их не просит ни один layout веба, и на клиент они не едут
 * вовсе — слово собирает сервер и отдаёт на провод готовой строкой. Размер им не
 * порок: это память сервера, а не байты человека (docs/i18n.md, правило страницы).
 */
const SERVER_ONLY_NAMESPACES = new Set(['errors', 'templates']);

/** Где искать употребление ключей (проверка 6). */
const CODE_ROOTS = [
  path.join(ROOT, 'apps', 'web', 'src'),
  path.join(ROOT, 'apps', 'api', 'src'),
  // Мобильный клиент берёт ТЕ ЖЕ каталоги; без него его ключи выглядели бы мёртвыми,
  // а предупреждение «ключ не встречается в коде» перестало бы что-то значить.
  path.join(ROOT, 'apps', 'mobile', 'app'),
  path.join(ROOT, 'apps', 'mobile', 'src'),
  // Пакеты тоже зовут ключи: renderChatter собирает ` + '`chatter.type.${typeKey}`' + `.
  path.join(ROOT, 'packages', 'i18n', 'src'),
  path.join(ROOT, 'packages', 'shared', 'src'),
  // Сиды тоже кладут КЛЮЧИ (имена скинов карточек — платформенный контент).
  path.join(ROOT, 'apps', 'api', 'scripts'),
];
const CODE_EXT = new Set(['.ts', '.tsx', '.cjs', '.mjs']);

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ---------- источники истины ----------
function listFromSource(file, constName) {
  const text = fs.readFileSync(file, 'utf8');
  const m = new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(text);
  if (!m) throw new Error(`${constName} не найден в ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const LOCALES = listFromSource(
  path.join(ROOT, 'packages', 'shared', 'src', 'constants', 'i18n.ts'),
  'SUPPORTED_LOCALES',
);
const SOURCE_LOCALE = (/SOURCE_LOCALE:\s*Locale\s*=\s*'([a-z-]+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'packages', 'shared', 'src', 'constants', 'i18n.ts'), 'utf8'),
) ?? [])[1];
const NAMESPACES = listFromSource(path.join(I18N, 'src', 'namespaces.ts'), 'NAMESPACES');

// ---------- 1. файлы на месте ----------
/** locale → ns → { tree, size } */
const catalogs = {};
for (const locale of LOCALES) {
  catalogs[locale] = {};
  const dir = path.join(MSG, locale);
  if (!fs.existsSync(dir)) {
    err(`нет папки каталогов: messages/${locale}`);
    continue;
  }
  for (const ns of NAMESPACES) {
    const file = path.join(dir, `${ns}.json`);
    if (!fs.existsSync(file)) {
      err(`нет файла messages/${locale}/${ns}.json — каждый неймспейс обязан быть во всех локалях`);
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    try {
      catalogs[locale][ns] = { tree: JSON.parse(raw), size: Buffer.byteLength(raw) };
    } catch (e) {
      err(`messages/${locale}/${ns}.json — не разбирается как JSON: ${e.message}`);
    }
  }
  // Лишние файлы: неймспейс завели, а в NAMESPACES не вписали — он не поедет никуда.
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const ns = file.slice(0, -'.json'.length);
    if (!NAMESPACES.includes(ns)) {
      err(`messages/${locale}/${file} — неймспейса «${ns}» нет в NAMESPACES (src/namespaces.ts)`);
    }
  }
}

/** Дерево → плоская карта «путь → строка». Не-строковые листья — ошибка формы. */
function flatten(tree, prefix, out, where) {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out, where);
    else err(`${where}: ключ «${full}» — не строка и не объект (${typeof value})`);
  }
  return out;
}

// ---------- 2–4. паритет ключей, разбор ICU, паритет плейсхолдеров ----------

/** Плейсхолдеры и ветки plural/select одного сообщения — форма, а не текст. */
function shapeOf(ast, acc = { args: new Set(), branches: new Set() }) {
  for (const node of ast) {
    if (!node || typeof node !== 'object') continue;
    if (node.value !== undefined && node.type === 1) acc.args.add(node.value); // {name}
    if (node.type === 2 || node.type === 3 || node.type === 4) acc.args.add(node.value); // number/date/time
    if (node.type === 5 || node.type === 6) {
      // select / plural
      acc.args.add(node.value);
      for (const [branch, opt] of Object.entries(node.options ?? {})) {
        acc.branches.add(`${node.value}:${branch}`);
        shapeOf(opt.value ?? [], acc);
      }
    }
    if (node.type === 8 && node.children) shapeOf(node.children, acc); // тег t.rich
  }
  return acc;
}

const flat = {}; // locale → ns → Map
for (const locale of LOCALES) {
  flat[locale] = {};
  for (const ns of NAMESPACES) {
    const entry = catalogs[locale]?.[ns];
    if (!entry) continue;
    flat[locale][ns] = flatten(entry.tree, '', new Map(), `messages/${locale}/${ns}.json`);
    if (entry.size > NAMESPACE_SIZE_WARN && !SERVER_ONLY_NAMESPACES.has(ns)) {
      warn(
        `messages/${locale}/${ns}.json — ${Math.round(entry.size / 1024)} КБ. ` +
          `Неймспейс целиком уезжает в браузер на своих страницах: пора делить.`,
      );
    }
  }
}

for (const ns of NAMESPACES) {
  const source = flat[SOURCE_LOCALE]?.[ns];
  if (!source) continue;

  // Разбор ICU + форма — по языку-источнику
  const shapes = new Map();
  for (const [key, message] of source) {
    try {
      shapes.set(key, shapeOf(parse(message)));
    } catch (e) {
      err(`messages/${SOURCE_LOCALE}/${ns}.json → ${key}: не разбирается как ICU — ${e.message}`);
    }
  }

  for (const locale of LOCALES) {
    if (locale === SOURCE_LOCALE) continue;
    const other = flat[locale]?.[ns];
    if (!other) continue;

    const missing = [...source.keys()].filter((k) => !other.has(k));
    const extra = [...other.keys()].filter((k) => !source.has(k));
    if (missing.length) {
      err(
        `messages/${locale}/${ns}.json — не хватает ${missing.length} ключей (есть в ${SOURCE_LOCALE}):\n    ` +
          missing.slice(0, 20).join('\n    ') + (missing.length > 20 ? '\n    …' : ''),
      );
    }
    if (extra.length) {
      err(
        `messages/${locale}/${ns}.json — ${extra.length} лишних ключей (нет в ${SOURCE_LOCALE}):\n    ` +
          extra.slice(0, 20).join('\n    ') + (extra.length > 20 ? '\n    …' : ''),
      );
    }

    for (const [key, message] of other) {
      let ast;
      try {
        ast = parse(message);
      } catch (e) {
        err(`messages/${locale}/${ns}.json → ${key}: не разбирается как ICU — ${e.message}`);
        continue;
      }
      const want = shapes.get(key);
      if (!want) continue;
      const got = shapeOf(ast);
      const lostArgs = [...want.args].filter((a) => !got.args.has(a));
      const newArgs = [...got.args].filter((a) => !want.args.has(a));
      if (lostArgs.length || newArgs.length) {
        err(
          `messages/${locale}/${ns}.json → ${key}: плейсхолдеры разошлись с ${SOURCE_LOCALE}` +
            (lostArgs.length ? ` (потеряны: ${lostArgs.join(', ')})` : '') +
            (newArgs.length ? ` (лишние: ${newArgs.join(', ')})` : ''),
        );
      }
      // Ветки plural проверяем в одну сторону: у русского их БОЛЬШЕ (few/many),
      // и это правильно — ошибка только когда ветки нет там, где язык её требует.
      const lostBranches = [...want.branches].filter((b) => {
        const [, branch] = b.split(':');
        return (branch === 'other' || branch === 'one') && !got.branches.has(b);
      });
      if (lostBranches.length) {
        err(
          `messages/${locale}/${ns}.json → ${key}: не хватает обязательных веток ` +
            `plural/select: ${lostBranches.join(', ')}`,
        );
      }
    }
  }
}

// ---------- 5. messages/index.ts соответствует диску ----------
{
  const indexPath = path.join(MSG, 'index.ts');
  if (!fs.existsSync(indexPath)) {
    err('нет packages/i18n/src/messages/index.ts — запустите `pnpm --filter @superapp/i18n gen`');
  } else {
    const text = fs.readFileSync(indexPath, 'utf8');
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        if (!text.includes(`./${locale}/${ns}.json`)) {
          err(
            `messages/index.ts не знает про ${locale}/${ns}.json — ` +
              'запустите `pnpm --filter @superapp/i18n gen`',
          );
        }
      }
    }
  }
}

// ---------- 5b. реестр уведомлений ⇔ каталог `notifications` ----------
// Тип объявляется в `packages/shared/src/notifications/<service>.ts`, а слова — в
// `notifications.<type>.title` (тело необязательно). Тип без заголовка показал бы
// человеку голый ключ; заголовок без типа — мёртвый текст, который никто не рендерит
// (динамический префикс `notifications.` прячет его от проверки 6).
{
  const regDir = path.join(ROOT, 'packages', 'shared', 'src', 'notifications');
  const registryTypes = new Set();
  if (fs.existsSync(regDir)) {
    for (const file of fs.readdirSync(regDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts' || file === 'types.ts') continue;
      const text = fs.readFileSync(path.join(regDir, file), 'utf8');
      for (const m of text.matchAll(/^\s*'([a-z_]+(?:\.[a-z_]+)+)':\s*\{/gm)) registryTypes.add(m[1]);
    }
  }
  if (!registryTypes.size) {
    err('реестр уведомлений не найден или пуст: packages/shared/src/notifications/*.ts');
  }
  for (const locale of LOCALES) {
    const cat = flat[locale]?.notifications;
    if (!cat) continue;
    const missing = [...registryTypes].filter((t) => !cat.has(`${t}.title`));
    if (missing.length) {
      err(
        `messages/${locale}/notifications.json — у ${missing.length} типов реестра нет \`.title\`:\n    ` +
          missing.slice(0, 20).join('\n    ') + (missing.length > 20 ? '\n    …' : ''),
      );
    }
  }
  // Ветки каталога, которые не типы: слова центра и настроек (`settings.quiet.title`
  // — заголовок блока, а не тип `settings.quiet`). Новая UI-ветка с `.title` внутри —
  // сюда, иначе страж примет её за осиротевший тип.
  const UI_BRANCHES = new Set(['settings', 'page', 'policy', 'meta', 'push', 'sms', 'chat', 'service', 'channel', 'priority']);
  const source = flat[SOURCE_LOCALE]?.notifications;
  if (source) {
    const orphans = [];
    for (const key of source.keys()) {
      const m = /^([a-z_]+(?:\.[a-z_]+)+)\.(title|body|collapsed)$/.exec(key);
      if (m && !UI_BRANCHES.has(m[1].split('.')[0]) && !registryTypes.has(m[1])) orphans.push(key);
    }
    if (orphans.length) {
      err(
        `messages/${SOURCE_LOCALE}/notifications.json — ${orphans.length} ключей типов, которых нет в реестре:\n    ` +
          orphans.slice(0, 20).join('\n    ') + (orphans.length > 20 ? '\n    …' : ''),
      );
    }
  }
}

// ---------- 6. ключ, которого нет в коде (предупреждение) ----------
{
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (CODE_EXT.has(path.extname(entry.name))) files.push(full);
    }
  };
  for (const root of CODE_ROOTS) walk(root);
  const haystack = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  // Ключи ЧАСТО собираются на лету: `errors.${code}`, `notifications.${type}.title`,
  // `chatter.type.${typeKey}`, `field.${key}`. Искать такой ключ целиком бессмысленно —
  // в коде его нет ни одной буквой. Поэтому сначала собираем ПРЕФИКСЫ сборки из
  // самих шаблонных строк, и всё, что под ними, считаем употреблённым.
  const dynamicPrefixes = [...haystack.matchAll(/[`'"]([A-Za-z0-9_.]+\.)\$\{/g)].map((m) => m[1]);

  const usedLiterally = (key) => haystack.includes(`'${key}'`) || haystack.includes(`"${key}"`) || haystack.includes('`' + key + '`');
  const usedDynamically = (key) => dynamicPrefixes.some((p) => key.startsWith(p));

  const unused = [];
  for (const ns of NAMESPACES) {
    for (const key of flat[SOURCE_LOCALE]?.[ns]?.keys() ?? []) {
      const full = `${ns}.${key}`;
      if (usedLiterally(key) || usedLiterally(full)) continue;
      if (usedDynamically(key) || usedDynamically(full)) continue;
      unused.push(full);
    }
  }
  if (unused.length) {
    warn(
      `${unused.length} ключей каталога не встречаются в коде (возможно, мёртвые):\n    ` +
        unused.slice(0, Number(process.env.I18N_UNUSED_LIMIT ?? 30)).join('\n    ') +
        (unused.length > Number(process.env.I18N_UNUSED_LIMIT ?? 30) ? '\n    …' : ''),
    );
  }
}

// ---------- 7. ключ, которого нет в каталоге (ошибка) ----------
//
// Зеркало проверки 6. Та ловит МЁРТВЫЙ ключ (лежит в каталоге, никто не просит),
// эта — ПРОПУЩЕННЫЙ (код просит, каталога нет). Пропущенный дороже: мёртвый ключ
// просто занимает место, а пропущенный человек ВИДИТ на экране машинным именем
// («circles.peopleCount» вместо «2 человека»), и узнаём мы об этом, только когда
// кто-то откроет ровно эту страницу и посмотрит в консоль.
//
// Проверяются ТОЛЬКО буквальные ключи: собранный на лету (`t(`level.${x}.short`)`)
// заранее не разрешить — его стерегут рантайм-`onError` и предупреждение 6.
{
  const known = (ns, key) => flat[SOURCE_LOCALE]?.[ns]?.has(key) === true;

  const codeFiles = [];
  const walkCode = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkCode(full);
      else if (CODE_EXT.has(path.extname(entry.name))) codeFiles.push(full);
    }
  };
  for (const root of CODE_ROOTS) walkCode(root);

  for (const file of codeFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const at = (index) =>
      `${path.relative(ROOT, file).split(path.sep).join('/')}:${src.slice(0, index).split('\n').length}`;

    // --- веб и серверные компоненты: имя переводчика связано с неймспейсом ---
    //
    // Связка действует от СВОЕГО объявления до следующего объявления того же
    // имени: `const tr = useTranslations(…)` пишется заново в каждом компоненте
    // файла, и неймспейсы у них разные. Взять последнее объявление на весь файл
    // значило бы приписать ключи чужому каталогу и получить десятки ложных тревог.
    const decls = [
      ...src.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*'([^']+)'\s*\)/g),
    ].map((m) => ({ at: m.index, name: m[1], ns: m[2] }));

    if (decls.length > 0) {
      for (const call of src.matchAll(/\b(\w+)(?:\.rich)?\(\s*'([A-Za-z0-9_.]+)'/g)) {
        let ns = null;
        for (const d of decls) if (d.name === call[1] && d.at < call.index) ns = d.ns;
        if (ns === null) continue; // это не переводчик, а обычный вызов
        if (!NAMESPACES.includes(ns)) err(`неймспейс «${ns}» не объявлен — ${at(call.index)}`);
        else if (!known(ns, call[2])) err(`код просит ключ, которого нет: ${ns}.${call[2]} — ${at(call.index)}`);
      }
    }

    // --- API: фабрики отказов называют ключ ветки `errors` ---
    for (const call of src.matchAll(
      /\b(?:notFound|forbidden|badRequest|conflict|tooMany|unprocessable|unauthorized)\(\s*'([A-Za-z0-9_.]+)'/g,
    )) {
      if (!known('errors', call[1])) err(`код просит ключ, которого нет: errors.${call[1]} — ${at(call.index)}`);
    }
  }
}

// ---------- отчёт ----------
const total = Object.values(flat[SOURCE_LOCALE] ?? {}).reduce((n, m) => n + m.size, 0);
for (const w of warnings) console.warn(`  ! ${w}`);
if (errors.length) {
  console.error(`\n[check:i18n] ${errors.length} ошибок:\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}
console.log(
  `[check:i18n] ок: ${LOCALES.length} локали × ${NAMESPACES.length} неймспейсов, ` +
    `${total} ключей, предупреждений: ${warnings.length}`,
);
