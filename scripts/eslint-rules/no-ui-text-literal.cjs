'use strict';

// ============================================================
// СТРАЖ ЯЗЫКА-ИСТОЧНИКА В ИНТЕРФЕЙСЕ.
//
// Соседнее правило (`no-cyrillic-literal`) ловит русскую строку в коде. Но
// язык-источник продукта — АНГЛИЙСКИЙ, и с этого дня естественная ошибка выглядит
// иначе: человек пишет `<span>Loading…</span>` или `placeholder="Search"` — по-английски,
// «правильно», — и строка проезжает молча. Она такой же один язык навсегда: у
// казахоязычного человека останется английской, потому что перевести её негде.
//
// Правило ловит текст для человека в двух местах интерфейса:
//   • текстовый узел JSX (`>Save changes<`);
//   • строковый литерал в АТРИБУТАХ, которые человек читает (`placeholder`, `title`,
//     `aria-label`, `alt`, `label`, `confirmText`…).
//
// Не трогает: технические атрибуты (className, href, id, data-*), знаки и числа
// («·», «—», «12»), односимвольные строки. Ключ каталога (`common.actions.save`)
// тоже проходит: в нём нет пробелов, зато есть точки.
// ============================================================

const MESSAGE =
  'Текст для человека не может быть литералом — даже английским: язык-источник живёт в каталоге, а не в коде. Заведите ключ в @superapp/i18n (сразу в en/kk/ru) и возьмите текст через useTranslations()/getTranslations().';

/** Атрибуты, значение которых человек читает глазами или слышит в скринридере */
const HUMAN_ATTRS = new Set([
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'confirmText',
  'cancelText',
  'emptyText',
  'submitText',
  'tooltip',
  'hint',
  'description',
]);

/** Похоже ли на ключ каталога (`notes.board.emptyTitle`) — точки есть, пробелов нет */
const looksLikeKey = (v) => !v.includes(' ') && v.includes('.');

/**
 * Фраза для человека — это ДВА и более слова из букв. Одно слово фразой не считаем
 * намеренно: там живут имена продуктов и сервисов («SuperApp6», «Google», «Telegram»),
 * которые не переводятся вовсе. Отбрасываем и образцы ввода — их человек не читает
 * как текст, а узнаёт по форме: «ASSEL NUROVA» (образец имени на карте, ВЕРХНИЙ
 * регистр), «KZ00 0000 0000», «user@example.com», «@username».
 */
function isHumanPhrase(raw) {
  const v = raw.trim();
  if (v.length < 3 || looksLikeKey(v)) return false;
  if (v.includes('@') || v.includes('://')) return false;
  const words = v.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w));
  if (words.length < 2) return false;
  // Образец, набранный ВЕРХНИМ регистром, — это форма, а не фраза.
  const letters = v.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) return false;
  return true;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'текст интерфейса берётся из каталога, а не из литерала' },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' } },
          allowAttributes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { uiText: '{{message}}' },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const filename = (context.filename ?? context.getFilename() ?? '')
      .split(String.fromCharCode(92))
      .join('/');
    if ((opts.allowFiles ?? []).some((f) => filename.includes(f.replace('/**', '')))) return {};
    const skipAttrs = new Set(opts.allowAttributes ?? []);

    const report = (node) => context.report({ node, messageId: 'uiText', data: { message: MESSAGE } });

    return {
      JSXText(node) {
        if (isHumanPhrase(node.value)) report(node);
      },

      JSXAttribute(node) {
        const name = node.name?.type === 'JSXIdentifier' ? node.name.name : null;
        if (!name || !HUMAN_ATTRS.has(name) || skipAttrs.has(name)) return;
        const v = node.value;
        if (v && v.type === 'Literal' && typeof v.value === 'string' && isHumanPhrase(v.value)) report(v);
        // `title={'Some text'}` — тот же литерал, только в фигурных скобках.
        if (
          v &&
          v.type === 'JSXExpressionContainer' &&
          v.expression.type === 'Literal' &&
          typeof v.expression.value === 'string' &&
          isHumanPhrase(v.expression.value)
        ) {
          report(v.expression);
        }
      },
    };
  },
};
