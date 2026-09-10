'use strict';

// ============================================================
// МЕХАНИЧЕСКИЙ СТРАЖ МУЛЬТИЯЗЫЧНОСТИ.
//
// Строка для человека, написанная литералом в коде, — это ОДИН язык навсегда.
// Её нельзя перевести, не тронув код; она не переезжает вместе с выбором языка;
// и она незаметна ровно до того дня, когда продукт открывает казахоязычный
// человек. Договорённостью это не удержать: литерал короче ключа и работает.
//
// Правило ловит кириллицу (русскую И казахскую) в:
//   • строковых литералах ('…', "…");
//   • шаблонных строках (`…`) — включая куски вокруг подстановок;
//   • текстовых узлах JSX (>текст<).
//
// И вторую половину той же ошибки — ЗАШИТЫЙ ЯЗЫК: `toLocaleDateString('ru-RU')`,
// `new Intl.NumberFormat('ru-RU')`, `a.localeCompare(b, 'ru')`. Кириллицы в такой
// строке нет, поэтому первый проход её не видел, а по-казахски она всё равно даёт
// русский месяц, русские разделители и русский ПОРЯДОК списка (Ә, Ғ, Қ, Ң, Ө, Ұ,
// Ү, Һ, І стоят в казахском алфавите своими местами). Формат и порядок берутся
// только у платформы (`@superapp/i18n/format`, `lib/format.ts`, `I18nService.format`).
//
// Комментарии НЕ трогаются намеренно: комментарии в этом проекте пишутся
// по-русски и объясняют «почему» — они часть кода, а не интерфейса.
//
// Исключения бывают двух видов:
//   1. ПОСТОЯННЫЕ (`allowFiles` в конфиге) — там, где кириллица и есть смысл:
//      витрина кита /dev/ui, платформенный контент бланков РК, DSL шаблонов,
//      автонимы языков;
//   2. ВРЕМЕННЫЕ — файл-ратчет `i18n.legacy.json` рядом с конфигом пакета:
//      список ещё не переведённых файлов. Он только СОКРАЩАЕТСЯ, и следит за
//      этим САМО правило: файл из списка, в котором кириллицы уже нет, — это
//      ошибка «убери строку из списка». Без такой проверки список превратился
//      бы в вечное разрешение: перевели файл, а исключение осталось висеть.
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

/** Русский + казахский алфавиты (ӘҒҚҢӨҰҮҺІ — буквы, которых нет в русском). */
const CYRILLIC = /[Ѐ-ӿ]/;

const MESSAGE =
  'Строка для человека не может быть литералом: её нельзя перевести. Заведите ключ в каталоге @superapp/i18n и возьмите текст через useTranslations()/getTranslations() (веб) или I18nService (API). Файл ещё не переведён целиком — впишите его в i18n.legacy.json рядом с eslint.config.mjs.';

const LOCALE_MESSAGE =
  'Язык зашит строкой: toLocaleString/Intl/localeCompare с литералом языка («ru-RU») навсегда делают дату, число, месяц и ПОРЯДОК списка русскими — независимо от того, что выбрал человек. Берите платформу: useFormatters() (веб) или I18nService.format() (API) — там же compare() для сортировки, — а первый аргумент только переменная языка зрителя.';

/**
 * Методы, у которых ПЕРВЫЙ аргумент — тег языка. Кроме дат сюда входят
 * `localeCompare` (ПОРЯДОК списка: в казахском Ә, Ғ, Қ, Ң, Ө, Ұ, Ү, Һ, І стоят
 * своими местами) и `toLocaleUpper/LowerCase` (регистр тоже язык: турецкое «i»).
 * Язык у них берётся у зрителя — `useFormatters().compare` / `I18nService.format()`.
 */
const LOCALE_METHODS = new Set([
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'localeCompare',
]);
/** Конструкторы `Intl`, у которых первый аргумент — тег языка. */
const INTL_CTORS = new Set([
  'DateTimeFormat',
  'NumberFormat',
  'RelativeTimeFormat',
  'ListFormat',
  'PluralRules',
  'Collator',
  'DisplayNames',
  'Segmenter',
]);

/**
 * Теги, которыми платформа получает МАШИННЫЙ ключ, а не текст для человека:
 * `en-CA` даёт ISO-порядок `YYYY-MM-DD` во всех рантаймах, `en-US` — стабильный
 * разбор частей даты в поясе (`formatToParts`, проверка существования зоны).
 * Разрешены только конструкторам `Intl.*`; у `toLocale…String` строка ВСЕГДА
 * показывается человеку, поэтому там исключений нет.
 */
const TECHNICAL_TAGS = new Set(['en-CA', 'en-US']);

/** Литерал похож на тег языка? `'ru'`, `'ru-RU'`, `'kk-Cyrl-KZ'` — да; `'2-digit'` — нет. */
function isLocaleTag(node) {
  return (
    node &&
    node.type === 'Literal' &&
    typeof node.value === 'string' &&
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(node.value)
  );
}

/** Тег языка, который НЕ входит в машинный белый список. */
function isHumanLocaleTag(node) {
  return isLocaleTag(node) && !TECHNICAL_TAGS.has(node.value);
}

/** Нормализация пути к POSIX-виду: конфиги пишутся одинаково на всех ОС. */
function posix(p) {
  return p.split(path.sep).join('/');
}

/** Глоб → регулярка. Поддерживаются `**`, `*` и `?` — большего здесь не нужно. */
function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, 'SLASHSTAR')
    .replace(/\*\*/g, 'STARSTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/SLASHSTAR/g, '(?:.*/)?')
    .replace(/STARSTAR/g, '.*');
  return new RegExp(`^${body}$`);
}

const legacyCache = new Map();

/**
 * Список ещё не переведённых файлов пакета. Ищем `i18n.legacy.json` вверх по
 * дереву от проверяемого файла — так один список обслуживает весь пакет и не
 * требует передавать пути в конфиг.
 */
function loadLegacy(fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'i18n.legacy.json');
    if (legacyCache.has(candidate)) {
      const hit = legacyCache.get(candidate);
      if (hit) return hit;
    } else if (fs.existsSync(candidate)) {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const files = Array.isArray(raw) ? raw : raw.files ?? [];
      const entry = { dir, set: new Set(files.map(posix)) };
      legacyCache.set(candidate, entry);
      return entry;
    } else {
      legacyCache.set(candidate, null);
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Текст и формат для человека — только через @superapp/i18n: ни кириллицы литералом, ни языка формата строкой',
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** ПОСТОЯННЫЕ исключения: глобы относительно корня пакета. */
          allowFiles: { type: 'array', items: { type: 'string' } },
          /** Имена переменных/свойств, значения которых — данные, а не текст. */
          allowIdentifiers: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { cyrillic: '{{hint}}' },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allow = (options.allowFiles ?? []).map(globToRe);
    const allowIdentifiers = new Set(options.allowIdentifiers ?? []);

    const filename = context.filename ?? context.getFilename();
    if (!filename || filename === '<input>') return {};

    const legacy = loadLegacy(path.dirname(filename));
    // База сравнения — папка самого списка (корень пакета), чтобы пути в
    // i18n.legacy.json читались как `src/app/tasks/page.tsx`.
    const base = legacy ? legacy.dir : process.cwd();
    const rel = posix(path.relative(base, filename));

    if (allow.some((re) => re.test(rel))) return {};

    // Файл в ратчете: литералы не ругаем, но СЧИТАЕМ — их отсутствие означает,
    // что строку из списка пора убрать.
    const inLegacy = !!(legacy && legacy.set.has(rel));
    let hits = 0;

    const report = (node, hint) => {
      hits += 1;
      if (inLegacy) return;
      context.report({ node, messageId: 'cyrillic', data: { hint } });
    };

    /** Литерал — значение белого списка (`LOCALE_NAMES` и т.п.)? */
    function inAllowedIdentifier(node) {
      if (allowIdentifiers.size === 0) return false;
      for (let cur = node.parent; cur; cur = cur.parent) {
        if (cur.type === 'VariableDeclarator' && cur.id?.type === 'Identifier' && allowIdentifiers.has(cur.id.name)) {
          return true;
        }
        if (cur.type === 'Property' && cur.key?.type === 'Identifier' && allowIdentifiers.has(cur.key.name)) {
          return true;
        }
      }
      return false;
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !CYRILLIC.test(node.value)) return;
        if (inAllowedIdentifier(node)) return;
        report(node, MESSAGE);
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (!CYRILLIC.test(raw)) return;
        if (inAllowedIdentifier(node)) return;
        report(node, MESSAGE);
      },
      JSXText(node) {
        if (!CYRILLIC.test(node.value)) return;
        report(node, MESSAGE);
      },
      // `d.toLocaleDateString('ru-RU', …)` — язык формата литералом.
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type === 'MemberExpression' && !callee.computed && LOCALE_METHODS.has(callee.property?.name)) {
          // У `localeCompare(that, locales)` язык — ВТОРОЙ аргумент, у остальных первый.
          const at = callee.property.name === 'localeCompare' ? 1 : 0;
          if (isLocaleTag(node.arguments[at])) report(node.arguments[at], LOCALE_MESSAGE);
          return;
        }
        // `Intl.DateTimeFormat('ru-RU')` — тот же конструктор без `new`.
        if (
          callee?.type === 'MemberExpression' &&
          callee.object?.type === 'Identifier' &&
          callee.object.name === 'Intl' &&
          INTL_CTORS.has(callee.property?.name) &&
          isHumanLocaleTag(node.arguments[0])
        ) {
          report(node.arguments[0], LOCALE_MESSAGE);
        }
      },
      // `new Intl.NumberFormat('ru-RU', …)`
      NewExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === 'MemberExpression' &&
          callee.object?.type === 'Identifier' &&
          callee.object.name === 'Intl' &&
          INTL_CTORS.has(callee.property?.name) &&
          isHumanLocaleTag(node.arguments[0])
        ) {
          report(node.arguments[0], LOCALE_MESSAGE);
        }
      },
      'Program:exit'(node) {
        if (!inLegacy || hits > 0) return;
        context.report({
          node,
          messageId: 'cyrillic',
          data: {
            hint: `Файл переведён — уберите «${rel}» из i18n.legacy.json. Список исключений только сокращается: пока строка в нём висит, следующая русская фраза в этом файле пройдёт молча.`,
          },
        });
      },
    };
  },
};
