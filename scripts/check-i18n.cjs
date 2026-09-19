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

// ---------- 5c. реестр подписи адресата ⇔ каталоги ----------
// Подпись адресата («Отдел «Продажи»», «Руководитель инициатора») собирается ПРИ
// ЧТЕНИИ из снимка: в вечной записи лежит ключ формы, а слово даёт каталог в языке
// зрителя. Ключи вида и якоря собираются на лету (`common.audience.kind.${kind}`) —
// проверка 7 их не видит, и пропажа перевода обнаружилась бы у пользователя вместо
// стража. Поэтому набор собирается из `constants/audiences.ts` (packages/shared) и сверяется явно.
{
  const src = fs.readFileSync(path.join(ROOT, 'packages', 'shared', 'src', 'constants', 'audiences.ts'), 'utf8');
  const forms = [...(/AUDIENCE_LABEL_FORMS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src)?.[1] ?? '')
    .matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  const kinds = listFromSource(path.join(ROOT, 'packages', 'shared', 'src', 'constants', 'audiences.ts'), 'AUDIENCE_KINDS');
  const anchors = [...(/AUDIENCE_ANCHOR_KEYS\s*:[^=]*=\s*\{([\s\S]*?)\}/.exec(src)?.[1] ?? '').matchAll(/:\s*'([^']+)'/g)].map(
    (m) => m[1],
  );
  const keys = [
    ...forms,
    ...kinds.map((k) => `common.audience.kind.${k}`),
    ...anchors.map((a) => `common.audience.anchor.${a}`),
  ];
  if (forms.length === 0 || kinds.length === 0 || anchors.length === 0) {
    err('реестр подписи адресата не разобрался: packages/shared/src/constants/audiences.ts');
  }
  for (const locale of LOCALES) {
    const missing = keys.filter((key) => {
      const ns = key.slice(0, key.indexOf('.'));
      const rest = key.slice(key.indexOf('.') + 1);
      return !flat[locale]?.[ns]?.has(rest);
    });
    if (missing.length) {
      err(
        `messages/${locale} — нет ${missing.length} ключей подписи адресата (core/audiences):\n    ` +
          missing.join('\n    '),
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

  /** Хвост полного пути: `browser.colName` от `drive.browser.colName`. */
  const suffixes = new Set();
  for (const ns of NAMESPACES) {
    for (const key of flat[SOURCE_LOCALE]?.[ns]?.keys() ?? []) {
      const parts = `${ns}.${key}`.split('.');
      for (let i = 1; i < parts.length; i++) suffixes.add(parts.slice(i).join('.'));
    }
  }
  const knownBySuffix = (key) => suffixes.has(key);

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

    // --- API: `I18nService` зовёт ключ ЦЕЛИКОМ, вместе с неймспейсом ---
    //
    // У сервера нет привязки «переводчик → неймспейс»: `this.i18n.translate('messenger.list.messageDeleted')`
    // называет полный путь. Без этой ветки опечатка доезжала до экрана буквально —
    // так `messenger.messageDeleted` (ключа нет вовсе) полгода отдавался мобильному
    // клиенту и списку чатов вместо «Сообщение удалено».
    for (const call of src.matchAll(
      /\.(?:translate|translateFor)\(\s*(?:[^,'"`()]+,\s*)?'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g,
    )) {
      const [ns, ...rest] = call[1].split('.');
      if (!NAMESPACES.includes(ns)) continue; // не ключ каталога, а чужой вызов с точкой
      if (!known(ns, rest.join('.'))) err(`код просит ключ, которого нет: ${call[1]} — ${at(call.index)}`);
    }

    // --- реестры: ключ приезжает ПРОПОМ (`labelKey: 'calendar.layer.tasks'`) ---
    //
    // Такой ключ не проходит ни через `useTranslations`, ни через `translate`:
    // его читает чужой компонент, и опечатка в реестре видна только на экране.
    // Путь бывает полным (реестр общего пакета) и относительным неймспейсу
    // потребителя (`browser.colName` у Диска) — принимаем оба.
    for (const call of src.matchAll(
      /\b(?:label|title|desc|description|hint|name|text|body|caption|placeholder|summary|subtitle|tooltip|aria)Key\s*[:=]\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g,
    )) {
      const key = call[1];
      const [ns, ...rest] = key.split('.');
      if (NAMESPACES.includes(ns) && known(ns, rest.join('.'))) continue;
      if (knownBySuffix(key)) continue;
      err(`реестр называет ключ, которого нет: ${key} — ${at(call.index)}`);
    }
  }
}

// ---------- 8. язык-источник чист (ошибка) ----------
//
// `SOURCE_LOCALE` — язык НАПИСАНИЯ: из него растут остальные каталоги, его же
// видит человек, чей язык платформе незнаком. Кириллица в нём означает ровно
// одно: фразу написали по-русски и забыли перевести, а «перевод» на ru потом
// сделали копией. Ловится это только здесь — стражи кода смотрят на КОД.
{
  const CYRILLIC = /[Ѐ-ӿ]/;
  for (const ns of NAMESPACES) {
    for (const [key, message] of flat[SOURCE_LOCALE]?.[ns] ?? []) {
      if (CYRILLIC.test(message)) {
        err(`messages/${SOURCE_LOCALE}/${ns}.json → ${key}: кириллица в языке-источнике — «${message}»`);
      }
    }
  }
}

// ---------- 9. DSL внутри фразы не переводится (ошибка) ----------
//
// `{{form.field}}`, `{{steps.agent.data.field}}`, `{Organization.Bin}` — это не
// слова, а ИДЕНТИФИКАТОРЫ: `processIdSchema` (shared) принимает только латиницу.
// Переведённый пример звал набрать то, что схема отвергнет, — и подсказка
// «подставьте {{form.поле}}» ломала ровно того человека, который ей поверил.
{
  const DSL = /\{\{'?([A-Za-z0-9_.]*[^A-Za-z0-9_.'{}\s][^'{}]*)'?\}\}/g;
  for (const locale of LOCALES) {
    for (const ns of NAMESPACES) {
      for (const [key, message] of flat[locale]?.[ns] ?? []) {
        for (const m of message.matchAll(DSL)) {
          err(`messages/${locale}/${ns}.json → ${key}: подстановка DSL переведена — «${m[0]}» (идентификаторы латинские во ВСЕХ языках)`);
        }
      }
    }
  }
}

// ---------- 10. множественное число по правилам ЯЗЫКА (ошибка) ----------
//
// Проверка 4 сверяет ветки с языком-источником, а у языка-источника их две
// (one/other). Русскому нужны четыре: без `many` «5 товаров» рендерится веткой
// `other`, и первая же правка `other` под дробное число («1,5 товара») молча
// делает «5 товара». Категории — CLDR.
{
  const REQUIRED = { en: ['one', 'other'], kk: ['one', 'other'], ru: ['one', 'few', 'many', 'other'] };
  const walkPlural = (nodes, visit) => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 6) visit(node);
      for (const opt of Object.values(node.options ?? {})) walkPlural(opt.value ?? [], visit);
      if (node.children) walkPlural(node.children, visit);
    }
  };
  for (const locale of LOCALES) {
    const need = REQUIRED[locale];
    if (!need) continue;
    for (const ns of NAMESPACES) {
      for (const [key, message] of flat[locale]?.[ns] ?? []) {
        let ast;
        try {
          ast = parse(message);
        } catch {
          continue; // разбор уже отругался проверкой 3
        }
        walkPlural(ast, (node) => {
          const branches = Object.keys(node.options ?? {});
          const missing = need.filter((b) => !branches.includes(b));
          if (missing.length) {
            err(`messages/${locale}/${ns}.json → ${key}: у «${node.value}» нет веток ${missing.join(', ')} — язык их требует (CLDR)`);
          }
        });
      }
    }
  }
}

// ---------- 11. перевод, который переводом не является (ошибка) ----------
//
// Казахский, скопированный с русского, проходит ВСЕ проверки выше: ключи на
// месте, ICU разбирается, плейсхолдеры совпадают. Видно это только человеку —
// и только тому, кто читает по-казахски. Поэтому совпадение kk и ru объявляется
// ЯВНО: список ниже — это «в обоих языках слово действительно одно и то же»
// (Телефон, Банк, Менеджер), а не «руки не дошли».
//
// Список работает в ОБЕ стороны: строка, которая перестала совпадать, обязана
// уйти из него — иначе он превращается в вечное разрешение, и следующая копия
// проедет молча.
{
  const listFile = path.join(MSG, 'identical-kk-ru.json');
  const declared = fs.existsSync(listFile) ? new Set(JSON.parse(fs.readFileSync(listFile, 'utf8'))) : new Set();
  const CYRILLIC = /[Ѐ-ӿ]/;
  const copies = [];
  const stale = [];
  for (const ns of NAMESPACES) {
    for (const [key, message] of flat.kk?.[ns] ?? []) {
      const full = `${ns}.${key}`;
      const same = flat.ru?.[ns]?.get(key) === message && CYRILLIC.test(message);
      if (same && !declared.has(full)) copies.push(full);
      if (!same && declared.has(full)) stale.push(full);
    }
  }
  if (copies.length) {
    err(
      `${copies.length} казахских строк дословно совпали с русскими. Переведите — или, если слово в обоих ` +
        `языках одно, впишите ключ в messages/identical-kk-ru.json:\n    ` +
        copies.slice(0, 20).join('\n    ') + (copies.length > 20 ? '\n    …' : ''),
    );
  }
  if (stale.length) {
    err(
      `${stale.length} ключей в messages/identical-kk-ru.json больше не совпадают — уберите их из списка:\n    ` +
        stale.slice(0, 20).join('\n    ') + (stale.length > 20 ? '\n    …' : ''),
    );
  }
  for (const full of declared) {
    const [ns, ...rest] = full.split('.');
    if (!flat.kk?.[ns]?.has(rest.join('.'))) {
      err(`messages/identical-kk-ru.json называет ключ, которого нет: ${full}`);
    }
  }
}

// ---------- 12. прямой апостроф в языке-источнике (ошибка) ----------
//
// В ICU одинарная кавычка — СЛУЖЕБНЫЙ символ: `'{` съедает подстановку целиком.
// Поэтому в английских фразах пишется типографский `’`, а прямой `'` остаётся
// ровно для экранирования (`'{'`).
{
  const source = flat[SOURCE_LOCALE];
  for (const ns of NAMESPACES) {
    for (const [key, message] of source?.[ns] ?? []) {
      // Экранирование ICU: кавычка «включает» буквальный режим, если сразу за
      // ней идёт `{`, `}` или `#`, и выключает его следующей кавычкой.
      const stripped = message.replace(/'[{}#][^']*'?/g, '').replace(/''/g, '');
      if (stripped.includes("'")) {
        err(`messages/${SOURCE_LOCALE}/${ns}.json → ${key}: прямой апостроф — служебный символ ICU, пишите «’»: «${message}»`);
      }
    }
  }
}

// ---------- 13. юридический текст согласий — контент в БД, не каталог (ошибка) ----------
//
// Документы платформы (core/consents) — неизменяемые подписанные версии в базе: человек
// принимает конкретную версию, а каталог правится релизом и версий не имеет. Текст документа,
// попавший в каталог, менялся бы задним числом под уже данными согласиями. В каталоге живут
// только короткие подписи интерфейса; длинная строка или ключ «текста документа» в
// `consents.*` / `shell.consents.*` — признак того, что документ пытаются провезти через i18n.
{
  const LEGAL_TEXT_MAX = 700;
  const LEGAL_KEY = /(^|\.)(body|bodies|fullText|documentText|summaryText|legalText)(\.|$)/;
  for (const locale of LOCALES) {
    const scopes = [
      ['consents', flat[locale]?.consents, () => true],
      ['shell', flat[locale]?.shell, (key) => key.startsWith('consents.')],
    ];
    for (const [ns, cat, inScope] of scopes) {
      for (const [key, message] of cat ?? []) {
        if (!inScope(key)) continue;
        if (LEGAL_KEY.test(key) || message.length > LEGAL_TEXT_MAX) {
          err(
            `messages/${locale}/${ns}.json → ${key}: текст документа согласий в каталоге i18n. Юридический текст — ` +
              `контент в БД (ConsentVersion: версии, хэш, подпись), исходники — apps/api/consents-texts/*.md; ` +
              `в каталоге — только короткие подписи (≤ ${LEGAL_TEXT_MAX} символов)`,
          );
        }
      }
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
