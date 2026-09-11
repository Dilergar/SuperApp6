'use strict';

// ============================================================
// СТРАЖ КОЛОНКИ: имя и заголовок в базе — либо данные человека, либо ПОМЕЧЕННОЕ автоимя.
//
// Соседние правила стерегут payload вечной записи и текст интерфейса. Осталась третья
// дверь: `create({ data: { name: i18n.translate(...) } })`. Слово, записанное прямо в
// колонку, живёт как данные — его увидит каждый читатель в языке того, кто его записал,
// и переводить его будет негде.
//
// Правило требует: если в колонку-имя кладут слово из каталога, рядом обязана лежать
// ПОМЕТКА, по которой читающий путь соберёт слово заново:
//   • `<имя>Key` + `<имя>Params` (заголовок шага, подпись узла),
//   • `autoNameKey` / `autoNameParams` (узел Диска),
//   • `autoName` (файл: ключ уезжает в `meta`).
// Либо в колонку кладут САМ КЛЮЧ (`failReason: reasonKey`) — тогда вызова переводчика
// здесь нет вовсе, и правило молчит.
// ============================================================

const MESSAGE =
  'Слово из каталога, записанное прямо в колонку, застывает в языке того, кто его записал. Положите рядом пометку автоимени (`<имя>Key`/`<имя>Params`, `autoNameKey`, `autoName`) — её соберёт читающий путь, — либо храните в колонке сам КЛЮЧ и переводите при чтении (docs/i18n.md).';

/** Колонки, которые человек читает как имя или заголовок */
const HUMAN_COLUMNS = new Set([
  'name',
  'title',
  'label',
  'subtitle',
  'caption',
  'reason',
  'failReason',
  'refTitle',
  'workspaceName',
  'docTypeName',
]);

/** Пометки «это автоимя, слово соберут при чтении» */
const MARKERS = ['Key', 'Params'];
const MARKER_PROPS = new Set(['autoName', 'autoNameKey', 'autoNameParams']);

/** Вызовы, отдающие ГОТОВОЕ слово продукта */
const WORD_METHODS = new Set(['translate', 'translateFor']);
const WORD_HELPERS = new Set(['src']);

function isWordCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  const prop = callee.property.name;
  return WORD_METHODS.has(prop) || WORD_HELPERS.has(prop);
}

function containsWordCall(node, depth = 0) {
  if (!node || typeof node.type !== 'string' || depth > 12) return false;
  if (isWordCall(node)) return true;
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      if (child.some((c) => containsWordCall(c, depth + 1))) return true;
    } else if (child && typeof child.type === 'string') {
      if (containsWordCall(child, depth + 1)) return true;
    }
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'слово в колонке-имени требует пометки автоимени' },
    schema: [
      {
        type: 'object',
        properties: { allowFiles: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: { columnWord: '{{message}}' },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const filename = (context.filename ?? context.getFilename() ?? '')
      .split(String.fromCharCode(92))
      .join('/');
    if ((opts.allowFiles ?? []).some((f) => filename.endsWith(f))) return {};

    return {
      // `create({ data: { … } })` / `update({ where, data: { … } })` — форма Prisma.
      'Property[key.name="data"] > ObjectExpression'(node) {
        const props = node.properties.filter((p) => p.type === 'Property' && !p.computed);
        const names = new Set(
          props.map((p) => (p.key.type === 'Identifier' ? p.key.name : null)).filter(Boolean),
        );
        for (const prop of props) {
          const name = prop.key.type === 'Identifier' ? prop.key.name : null;
          if (!name || !HUMAN_COLUMNS.has(name)) continue;
          if (!containsWordCall(prop.value)) continue;
          const marked =
            MARKERS.some((suffix) => names.has(`${name}${suffix}`)) ||
            [...names].some((n) => MARKER_PROPS.has(n));
          if (!marked) context.report({ node: prop, messageId: 'columnWord', data: { message: MESSAGE } });
        }
      },
    };
  },
};
