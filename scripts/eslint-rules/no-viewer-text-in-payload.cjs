'use strict';

// ============================================================
// СТРАЖ ВЕЧНОЙ ЗАПИСИ: в payload хроники, уведомления, джоба и журнала безопасности —
// структура, не слово.
//
// Запись хроники и уведомление живут в БД годами, а текст собирается ПРИ ЧТЕНИИ в
// языке зрителя (render-at-read, docs/i18n.md). Стоит продюсеру положить туда уже
// переведённую строку — «Отдел «Продажи»», `i18n.translate(...)`, подпись адресата
// текстом, — и слово застывает в языке того, кто нажал кнопку: английский читатель
// получает русский кусок внутри английской фразы, и починить это можно только
// миграцией данных, которой не существует (разобрать фразу обратно нельзя).
//
// Литерала в коде тут НЕТ — фразу собирает сервер, — поэтому ни компилятор, ни страж
// кириллицы этого не видят. Ровно так «Отдел» застыл в хронике Диска и Заметок и в
// снимке шага согласования (найдено 2026-09-10).
//
// Правило запрещает в объектах-payload:
//   • вызовы переводчика (`i18n.translate`, `translateFor`, `i18n.t(...)`);
//   • витринные подписи движков (`labelText`, `labelTexts`, `renderAudienceLabel`);
//   • переменные, инициализированные такими вызовами.
// Вместо слова кладут структуру: `<имя>Key` (ключ каталога), `<имя>Audience`
// (снимок адресата), `<имя>Iso` (машинная дата).
// ============================================================

const HINT =
  'В вечную запись (payload хроники/уведомления/джоба) нельзя класть переведённый текст: он застынет в языке того, кто нажал кнопку. Положи СТРУКТУРУ — `<имя>Key` (ключ каталога), `<имя>Audience` (снимок адресата через labelSnapshot), `<имя>Iso` (машинная дата), — слово соберёт читающий (docs/i18n.md).';

/** Методы, возвращающие ГОТОВОЕ СЛОВО: в языке зрителя (витрина) или источника (снимок) */
const VIEWER_METHODS = new Set(['translate', 'translateFor', 'labelText', 'labelTexts']);
/**
 * Свободные функции того же смысла. `fullName`/`fullNameOrNull` сюда НЕ входят: они
 * отдают имя человека (данные) и с 2026-09-10 не имеют слова-заглушки вовсе — пустое
 * имя они возвращают пустым, а слово подставляет каталог при чтении.
 */
const VIEWER_FUNCTIONS = new Set(['renderAudienceLabel', 'renderChatter']);
/** Локальные обёртки над переводчиком языка ИСТОЧНИКА: `private src = (key) => translateFor(SOURCE_LOCALE, key)` */
const SOURCE_HELPERS = new Set(['src']);
/**
 * Приёмники вечных записей: объект-аргумент этих вызовов проверяется целиком. `record*` —
 * журнал безопасности (core/audit): его строки живут годами и рендерятся при чтении так же.
 */
const SINK_METHODS = new Set(['log', 'send', 'enqueue', 'record', 'recordOnce', 'recordBestEffort', 'recordBatch']);
/**
 * Типы вечной записи. Продюсер часто собирает её ЗАРАНЕЕ — в переменную с аннотацией
 * или через `satisfies`, — и до вызова приёмника объект правилу не виден.
 */
const SINK_TYPES = new Set(['ChatterLogInput', 'NotificationInput', 'SystemPlaque', 'AuditRecordInput']);

function isViewerCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return VIEWER_FUNCTIONS.has(callee.name);
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  const prop = callee.property.name;
  if (VIEWER_METHODS.has(prop)) return true;
  // `this.src('ключ')` — местная обёртка над языком источника: то же слово, только
  // короче записанное.
  if (SOURCE_HELPERS.has(prop)) return true;
  // `this.i18n.t('key')` — переводчик языка запроса вызовом геттера.
  if (prop === 't') {
    const obj = callee.object;
    return obj.type === 'MemberExpression' && !obj.computed && obj.property.name === 'i18n';
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'вечный payload несёт структуру, а не переведённое слово' },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: { viewerText: '{{hint}}' },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const filename = (context.filename ?? context.getFilename() ?? '').split(String.fromCharCode(92)).join('/');
    if ((opts.allowFiles ?? []).some((f) => filename.endsWith(f))) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** Объекты-payload, которые предстоит проверить (один и тот же — по разу) */
    const suspects = new Set();

    /** Переменная, чьё значение — текст зрителя (`const label = await audiences.labelText(...)`) */
    function taintedIdentifier(node) {
      let scope = sourceCode.getScope(node);
      let variable = null;
      while (scope && !variable) {
        variable = scope.variables.find((v) => v.name === node.name) ?? null;
        scope = scope.upper;
      }
      const def = variable?.defs?.[0];
      if (!def || def.type !== 'Variable' || !def.node.init) return false;
      let init = def.node.init;
      if (init.type === 'AwaitExpression') init = init.argument;
      if (isViewerCall(init)) return true;
      // `const x = user ? name : i18n.translate('common.labels.someone')` — слово в ветке.
      if (init.type === 'ConditionalExpression') {
        return isViewerCall(unwrap(init.consequent)) || isViewerCall(unwrap(init.alternate));
      }
      if (init.type === 'LogicalExpression') {
        return isViewerCall(unwrap(init.left)) || isViewerCall(unwrap(init.right));
      }
      return false;
    }

    function unwrap(node) {
      return node && node.type === 'AwaitExpression' ? node.argument : node;
    }

    /**
     * Обход значения payload. Мимо идут: имена полей (`row.name` — не переменная
     * `name`), ключи свойств и поддерево `changes` — «было → стало» держит СНИМОК
     * display-строки намеренно, правда лежит рядом в `raw` ключом (docs/chatter_engine.md).
     */
    function walkValue(node, reported, guard = null) {
      if (!node || typeof node.type !== 'string') return;
      if (isViewerCall(node)) {
        // `actor ? fullName(actor) : null` — имя уже под охраной: слова-заглушки не
        // будет, в записи окажется либо имя, либо пусто. Это законная форма.
        if (!isGuarded(node, guard)) report(node, reported);
        return;
      }
      if (node.type === 'Identifier') {
        if (taintedIdentifier(node)) report(node, reported);
        return;
      }
      // Тернарник вводит охрану для своих ветвей: `x ? … : …` проверяет `x`.
      if (node.type === 'ConditionalExpression') {
        walkValue(node.test, reported, guard);
        const inner = sourceCode.getText(node.test).trim();
        walkValue(node.consequent, reported, inner);
        walkValue(node.alternate, reported, inner);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        // Ключ свойства и имя поля — не значения.
        if (node.type === 'Property' && key === 'key') continue;
        if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
        if (node.type === 'Property' && isChangesKey(node)) continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => walkValue(c, reported, guard));
        else if (child && typeof child.type === 'string') walkValue(child, reported, guard);
      }
    }

    /** Вызов стоит в ветви тернарника, который проверяет ЕГО ЖЕ аргумент */
    function isGuarded(callNode, guard) {
      if (!guard || !callNode.arguments?.length) return false;
      return sourceCode.getText(callNode.arguments[0]).trim() === guard;
    }

    /** Имя типа из аннотации: `ChatterLogInput` и `ChatterLogInput[]` — одно и то же */
    function typeNameOf(typeNode) {
      if (!typeNode) return null;
      if (typeNode.type === 'TSArrayType') return typeNameOf(typeNode.elementType);
      if (typeNode.type === 'TSTypeReference' && typeNode.typeName?.type === 'Identifier') {
        return typeNode.typeName.name;
      }
      return null;
    }

    function isChangesKey(prop) {
      return prop.key && !prop.computed && prop.key.type === 'Identifier' && prop.key.name === 'changes';
    }

    function report(node, reported) {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId: 'viewerText', data: { hint: HINT } });
    }

    return {
      // `payload: { … }` — форма движков хроники, уведомлений и джобов.
      'Property[key.name="payload"]'(node) {
        if (node.value.type === 'ObjectExpression') suspects.add(node.value);
      },

      // `const entry = { … } satisfies ChatterLogInput` / `const e: ChatterLogInput = { … }`
      // — запись, собранная заранее: приёмник её получит позже, а слово застынет уже здесь.
      TSSatisfiesExpression(node) {
        if (node.expression.type === 'ObjectExpression' && typeNameOf(node.typeAnnotation)) {
          if (SINK_TYPES.has(typeNameOf(node.typeAnnotation))) suspects.add(node.expression);
        }
      },

      'VariableDeclarator[id.typeAnnotation]'(node) {
        const name = typeNameOf(node.id.typeAnnotation.typeAnnotation);
        if (!name || !SINK_TYPES.has(name) || !node.init) return;
        if (node.init.type === 'ObjectExpression') suspects.add(node.init);
        if (node.init.type === 'ArrayExpression') {
          for (const el of node.init.elements) if (el && el.type === 'ObjectExpression') suspects.add(el);
        }
      },

      // Объект-аргумент приёмника целиком: `notes.log(tx, scope, id, 'key', { … })`
      // (payload позиционным аргументом у сервисов-обёрток) и форма самого движка
      // `{ refType, refId, actorName, payload }` — в ней слово может застыть не только
      // внутри payload, но и в снимке имени актора рядом с ним.
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (!SINK_METHODS.has(callee.property.name)) return;
        for (const arg of node.arguments) {
          if (arg.type === 'ObjectExpression') suspects.add(arg);
        }
      },

      'Program:exit'() {
        const reported = new Set();
        for (const obj of suspects) walkValue(obj, reported);
      },
    };
  },
};
