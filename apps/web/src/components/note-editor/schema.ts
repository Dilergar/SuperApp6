import { Schema, type Node as PMNode, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { normalizeNoteHref } from '@superapp/shared';
import { noteEditorLabels } from './labels';
import type { NoteDoc } from '@superapp/shared';

// ============================================================
// ProseMirror-схема редактора заметок — ЗЕРКАЛО формата NoteDoc из @superapp/shared.
// Единственная точка конверсии на клиенте: toNoteDoc / fromNoteDoc. Новый вид узла
// появляется СНАЧАЛА в shared (NoteDoc + Zod + проекции), потом здесь.
// ============================================================

const tables = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} });

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  horizontalRule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  codeBlock: {
    attrs: { language: { default: null } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (node) => ['pre', { 'data-language': node.attrs.language ?? undefined }, ['code', 0]],
  },

  bulletList: {
    content: 'listItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: () => ['ul', 0],
  },

  orderedList: {
    attrs: { start: { default: 1 } },
    content: 'listItem+',
    group: 'block',
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ start: (dom as HTMLElement).hasAttribute('start') ? +(dom as HTMLElement).getAttribute('start')! : 1 }) }],
    toDOM: (node) => (node.attrs.start === 1 ? ['ol', 0] : ['ol', { start: node.attrs.start }, 0]),
  },

  listItem: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },

  taskList: {
    content: 'taskItem+',
    group: 'block',
    parseDOM: [{ tag: 'ul[data-task-list]' }],
    toDOM: () => ['ul', { 'data-task-list': '' }, 0],
  },

  taskItem: {
    attrs: { checked: { default: false } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li[data-task-item]', getAttrs: (dom) => ({ checked: (dom as HTMLElement).getAttribute('data-checked') === 'true' }) }],
    // Чекбокс рисует NodeView (клик по нему не должен трогать каретку) — здесь запасной DOM
    toDOM: (node) => ['li', { 'data-task-item': '', 'data-checked': String(node.attrs.checked) }, 0],
  },

  image: {
    attrs: { fileId: {}, alt: { default: null }, width: { default: null } },
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    parseDOM: [{ tag: 'figure[data-file-id]', getAttrs: (dom) => ({ fileId: (dom as HTMLElement).getAttribute('data-file-id'), alt: (dom as HTMLElement).getAttribute('data-alt'), width: null }) }],
    toDOM: (node) => ['figure', { 'data-file-id': node.attrs.fileId, 'data-alt': node.attrs.alt ?? '' }],
  },

  text: { group: 'inline' },

  hardBreak: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  mention: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    attrs: { userId: {}, name: {} },
    parseDOM: [{ tag: 'span[data-mention-id]', getAttrs: (dom) => ({ userId: (dom as HTMLElement).getAttribute('data-mention-id'), name: (dom as HTMLElement).getAttribute('data-mention-name') ?? '' }) }],
    toDOM: (node) => ['span', { 'data-mention-id': node.attrs.userId, 'data-mention-name': node.attrs.name, class: 'ne-mention' }, `@${node.attrs.name}`],
  },

  wikilink: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    attrs: { noteId: {}, title: { default: '' } },
    parseDOM: [{ tag: 'span[data-wikilink-id]', getAttrs: (dom) => ({ noteId: (dom as HTMLElement).getAttribute('data-wikilink-id'), title: (dom as HTMLElement).getAttribute('data-wikilink-title') ?? '' }) }],
    toDOM: (node) => ['span', { 'data-wikilink-id': node.attrs.noteId, 'data-wikilink-title': node.attrs.title, class: 'ne-wikilink' }, `[[${node.attrs.title}]]`],
  },

  tag: {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    attrs: { name: {} },
    parseDOM: [{ tag: 'span[data-tag]', getAttrs: (dom) => ({ name: (dom as HTMLElement).getAttribute('data-tag') }) }],
    toDOM: (node) => ['span', { 'data-tag': node.attrs.name, class: 'ne-tag' }, `#${node.attrs.name}`],
  },

  // prosemirror-tables: table / table_row / table_cell / table_header (имена библиотеки;
  // в NoteDoc они переименовываются в tableRow / tableCell / tableHeader)
  ...tables,
};

const marks: Record<string, MarkSpec> = {
  // Адрес ссылки проходит белый список схем на ОБОИХ путях: вставка HTML из буфера
  // (parseDOM) и рендер (toDOM). `javascript:` из чужой заметки не должен доехать
  // ни до документа, ни до атрибута href — иначе клик выполняет код в сессии зрителя.
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = normalizeNoteHref((dom as HTMLElement).getAttribute('href'));
          return href ? { href } : false;
        },
      },
    ],
    toDOM: (mark) => {
      const href = normalizeNoteHref(mark.attrs.href);
      return href
        ? ['a', { href, rel: 'noopener noreferrer nofollow', target: '_blank', class: 'ne-link' }, 0]
        : ['span', { class: 'ne-link ne-link--blocked', title: noteEditorLabels.blockedLink }, 0];
    },
  },
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight', getAttrs: (v) => (/^(bold|[5-9]\d{2})$/.test(v as string) ? null : false) }],
    toDOM: () => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM: () => ['u', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0],
  },
  code: {
    excludes: '_',
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', { class: 'ne-code' }, 0],
  },
};

export const noteSchema = new Schema({ nodes, marks });

// ---------------------------------------------------------------- конверсия

const TABLE_TO_DOC: Record<string, string> = { table: 'table', table_row: 'tableRow', table_cell: 'tableCell', table_header: 'tableHeader' };
const TABLE_FROM_DOC: Record<string, string> = { tableRow: 'table_row', tableCell: 'table_cell', tableHeader: 'table_header' };

type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: unknown[] };

/** PM-документ → NoteDoc (канон провода). Табличные имена и служебные атрибуты ячеек убираются. */
export function toNoteDoc(doc: PMNode): NoteDoc {
  const json = doc.toJSON() as JsonNode;
  const walk = (n: JsonNode): JsonNode => {
    const out: JsonNode = { type: TABLE_TO_DOC[n.type] ?? n.type };
    if (n.text !== undefined) out.text = n.text;
    if (n.marks && n.marks.length) out.marks = n.marks;
    if (n.attrs && !['table', 'table_row', 'table_cell', 'table_header', 'paragraph'].includes(n.type)) {
      const attrs = pruneNulls(n.attrs, n.type);
      if (Object.keys(attrs).length) out.attrs = attrs;
    }
    if (n.content && n.content.length) out.content = n.content.map(walk);
    return out;
  };
  return walk(json) as unknown as NoteDoc;
}

/** null-атрибуты, которые Zod принимает как «нет значения», не тащим в канон */
function pruneNulls(attrs: Record<string, unknown>, type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (type === 'orderedList' && k === 'start' && v === 1) continue;
    out[k] = v;
  }
  return out;
}

/** NoteDoc → PM-документ. Незнакомое отбрасывается схемой (fail-closed на клиенте не нужен — сервер уже проверил). */
export function fromNoteDoc(doc: NoteDoc): PMNode {
  const walk = (n: JsonNode): JsonNode => {
    const type = TABLE_FROM_DOC[n.type] ?? n.type;
    const out: JsonNode = { type };
    if (n.text !== undefined) out.text = n.text;
    if (n.marks) out.marks = safeMarks(n.marks);
    if (n.attrs) out.attrs = n.attrs;
    if (n.content) out.content = n.content.map(walk);
    return out;
  };
  try {
    return noteSchema.nodeFromJSON(walk(doc as unknown as JsonNode));
  } catch {
    return noteSchema.node('doc', null, [noteSchema.node('paragraph')]);
  }
}

/**
 * Марки документа перед загрузкой в редактор: ссылка с адресом вне белого списка
 * снимается совсем. Документ мог быть записан до этой проверки — иначе редактор
 * тащил бы её обратно на сервер, где Zod теперь отвергает весь документ.
 */
function safeMarks(marks: unknown[]): unknown[] {
  return marks.filter((m) => {
    const mark = m as { type?: string; attrs?: { href?: unknown } };
    return mark?.type !== 'link' || normalizeNoteHref(mark.attrs?.href) !== null;
  });
}
