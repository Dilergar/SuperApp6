import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn, lift, joinUp, selectParentNode } from 'prosemirror-commands';
import { redo, undo, history } from 'prosemirror-history';
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Fragment, type MarkType, type Node as PMNode, type NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, Plugin, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  mergeCells,
  splitCell,
  tableEditing,
  toggleHeaderRow,
} from 'prosemirror-tables';
import { noteEditorLabels } from './labels';
import { noteSchema } from './schema';

// ============================================================
// Команды, клавиатура, автозамены и служебные плагины редактора заметок.
// Всё — поверх ProseMirror-ядра; UI (панель, меню) читает снимок состояния.
// ============================================================

const s = noteSchema;

// ---------------------------------------------------------------- команды

export type BlockKind = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'codeBlock';
export type ListKind = 'bullet' | 'ordered' | 'task';

export const cmd = {
  bold: toggleMark(s.marks.bold),
  italic: toggleMark(s.marks.italic),
  underline: toggleMark(s.marks.underline),
  strike: toggleMark(s.marks.strike),
  code: toggleMark(s.marks.code),
  undo,
  redo,
  setBlock(kind: BlockKind): Command {
    if (kind === 'paragraph') return setBlockType(s.nodes.paragraph);
    if (kind === 'codeBlock') return setBlockType(s.nodes.codeBlock);
    return setBlockType(s.nodes.heading, { level: Number(kind.slice(-1)) });
  },
  toggleList(kind: ListKind): Command {
    return (state, dispatch, view) => {
      const listType = kind === 'bullet' ? s.nodes.bulletList : kind === 'ordered' ? s.nodes.orderedList : s.nodes.taskList;
      const itemType = kind === 'task' ? s.nodes.taskItem : s.nodes.listItem;
      const current = listAround(state);
      // Уже в списке этого вида — снять; в другом списке — сначала снять его
      if (current && current.type === listType) return liftListItem(current.itemType)(state, dispatch, view);
      if (current) {
        if (!dispatch) return true;
        // двухшаговая замена: снять текущий список, потом обернуть в новый
        let ok = false;
        liftListItem(current.itemType)(state, (tr) => {
          const next = state.apply(tr);
          wrapInList(listType)(next, (tr2) => {
            dispatch(tr2.setMeta('addToHistory', true));
            ok = true;
          }, view);
          if (!ok) dispatch(tr);
        }, view);
        return true;
      }
      return wrapInList(listType)(state, dispatch, view);
    };
  },
  toggleBlockquote: (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => {
    const inQuote = ancestorOfType(state, s.nodes.blockquote);
    return inQuote ? lift(state, dispatch, view) : wrapIn(s.nodes.blockquote)(state, dispatch, view);
  },
  insertHorizontalRule: ((state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(s.nodes.horizontalRule.create()).scrollIntoView());
    return true;
  }) as Command,
  toggleTaskChecked: ((state, dispatch) => {
    const $from = state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === s.nodes.taskItem) {
        if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
        return true;
      }
    }
    return false;
  }) as Command,
  setLink(href: string | null): Command {
    return (state, dispatch) => {
      const { from, to, empty } = state.selection;
      if (empty) return false;
      if (!dispatch) return true;
      const tr = state.tr.removeMark(from, to, s.marks.link);
      if (href) tr.addMark(from, to, s.marks.link.create({ href }));
      dispatch(tr);
      return true;
    };
  },
  insertImage(fileId: string, alt: string | null): Command {
    return (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(s.nodes.image.create({ fileId, alt })).scrollIntoView());
      return true;
    };
  },
  // Действия с таблицей — из prosemirror-tables; работают только при плагине
  // tableEditing (он держит выделение ячеек), см. basePlugins.
  addRowBefore,
  addRowAfter,
  deleteRow,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  toggleHeaderRow,
  mergeCells,
  splitCell,
  deleteTable,
  insertTable(rows = 3, cols = 3): Command {
    return (state, dispatch) => {
      const cell = (type: NodeType) => type.createAndFill()!;
      const header = s.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(s.nodes.table_header)));
      const body = Array.from({ length: rows - 1 }, () => s.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(s.nodes.table_cell))));
      const table = s.nodes.table.create(null, [header, ...body]);
      if (dispatch) dispatch(state.tr.replaceSelectionWith(table).scrollIntoView());
      return true;
    };
  },
};

/** Вставить текст в позицию каретки (диктовка): пробел перед, каретка после */
export function insertTextAtCaret(view: EditorView, text: string): void {
  const { from, to, $from } = view.state.selection;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
  const needsSpace = before && !/\s/.test(before) ? ' ' : '';
  const tr = view.state.tr.insertText(needsSpace + text, from, to);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Вставить инлайн-узел вместо диапазона (упоминание/ссылка/тег из меню подсказок) + пробел */
export function replaceRangeWithNode(view: EditorView, from: number, to: number, node: PMNode): void {
  const tr = view.state.tr.replaceWith(from, to, [node, s.text(' ')]);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Удалить диапазон (текст `/команда`) и выполнить команду */
export function runSlashCommand(view: EditorView, from: number, to: number, command: Command): void {
  view.dispatch(view.state.tr.delete(from, to));
  command(view.state, view.dispatch, view);
  view.focus();
}

function listAround(state: EditorState): { type: NodeType; itemType: NodeType } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === s.nodes.bulletList || node.type === s.nodes.orderedList) return { type: node.type, itemType: s.nodes.listItem };
    if (node.type === s.nodes.taskList) return { type: node.type, itemType: s.nodes.taskItem };
  }
  return null;
}

function ancestorOfType(state: EditorState, type: NodeType): boolean {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

// ---------------------------------------------------------------- снимок для панели

export interface EditorSnapshot {
  marks: Record<'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link', boolean>;
  block: BlockKind;
  list: ListKind | null;
  quote: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  linkHref: string | null;
  /** Каретка внутри таблицы — панель показывает действия с ней */
  inTable: boolean;
}

export function snapshot(state: EditorState): EditorSnapshot {
  const { $from, empty } = state.selection;
  const has = (m: MarkType) => (empty ? !!m.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(state.selection.from, state.selection.to, m));
  const parent = $from.parent;
  let block: BlockKind = 'paragraph';
  if (parent.type === s.nodes.heading) block = `heading${parent.attrs.level}` as BlockKind;
  else if (parent.type === s.nodes.codeBlock) block = 'codeBlock';
  const list = listAround(state);
  const linkMark = $from.marks().find((m) => m.type === s.marks.link);
  return {
    marks: {
      bold: has(s.marks.bold),
      italic: has(s.marks.italic),
      underline: has(s.marks.underline),
      strike: has(s.marks.strike),
      code: has(s.marks.code),
      link: has(s.marks.link),
    },
    block,
    list: list ? (list.type === s.nodes.bulletList ? 'bullet' : list.type === s.nodes.orderedList ? 'ordered' : 'task') : null,
    quote: ancestorOfType(state, s.nodes.blockquote),
    canUndo: undo(state),
    canRedo: redo(state),
    hasSelection: !empty,
    inTable: isInTable(state),
    linkHref: (linkMark?.attrs.href as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------- клавиатура

export function buildKeymap(): Plugin {
  const enterInList = chainCommands(splitListItem(s.nodes.taskItem), splitListItem(s.nodes.listItem));
  return keymap({
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-b': cmd.bold,
    'Mod-i': cmd.italic,
    'Mod-u': cmd.underline,
    'Mod-Shift-s': cmd.strike,
    'Mod-e': cmd.code,
    'Mod-Alt-0': cmd.setBlock('paragraph'),
    'Mod-Alt-1': cmd.setBlock('heading1'),
    'Mod-Alt-2': cmd.setBlock('heading2'),
    'Mod-Alt-3': cmd.setBlock('heading3'),
    'Mod-Shift-8': cmd.toggleList('bullet'),
    'Mod-Shift-7': cmd.toggleList('ordered'),
    'Mod-Shift-9': cmd.toggleList('task'),
    'Mod-Enter': chainCommands(cmd.toggleTaskChecked, exitCode),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(s.nodes.hardBreak.create()).scrollIntoView());
      return true;
    }),
    Enter: enterInList,
    // В таблице Tab ходит по ячейкам (иначе из неё нельзя выбраться клавиатурой),
    // вне таблицы — вкладывает пункт списка.
    Tab: chainCommands(goToNextCell(1), sinkListItem(s.nodes.taskItem), sinkListItem(s.nodes.listItem)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(s.nodes.taskItem), liftListItem(s.nodes.listItem)),
    'Alt-ArrowUp': joinUp,
    Escape: selectParentNode,
  });
}

// ---------------------------------------------------------------- автозамены (Markdown-шорткаты)

const TAG_RULE = /(^|\s)#([\p{L}\p{N}_-]{1,40})\s$/u;

export function buildInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,3})\s$/, s.nodes.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, s.nodes.bulletList),
      wrappingInputRule(/^(\d+)\.\s$/, s.nodes.orderedList, (m) => ({ start: +m[1] }), (m, node) => node.childCount + (node.attrs.start as number) === +m[1]),
      wrappingInputRule(/^\s*\[([ xX]?)\]\s$/, s.nodes.taskList, (m) => ({}), () => true),
      wrappingInputRule(/^\s*>\s$/, s.nodes.blockquote),
      textblockTypeInputRule(/^```([\w+-]*)\s$/, s.nodes.codeBlock, (m) => ({ language: m[1] || null })),
      new InputRule(/^(?:---|—-|\*\*\*)$/, (state, _match, start, end) => state.tr.replaceWith(start - 1, end, s.nodes.horizontalRule.create())),
      // `#тег␣` → узел тега (теги заметки выводятся сервером из документа)
      new InputRule(TAG_RULE, (state, match, start, end) => {
        const lead = match[1].length;
        const node = s.nodes.tag.create({ name: match[2] });
        return state.tr.replaceWith(start + lead, end, [node, s.text(' ')]);
      }),
    ],
  });
}

// ---------------------------------------------------------------- плейсхолдер

/**
 * Плейсхолдеры и роль первой строки.
 *
 * Названия у заметки нет отдельным полем: название — ПЕРВАЯ СТРОКА документа
 * (модель Apple Notes; в Obsidian ту же роль играет имя файла, показанное инлайн-
 * заголовком). Поэтому первый блок помечается `ne-title-line` — он рисуется крупно
 * и по центру, а пустой показывает «Без названия». Подсказка про «/» переезжает на
 * вторую строку, чтобы не спорить с названием.
 */
export function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        const first = doc.firstChild;
        if (!first) return DecorationSet.empty;
        const decos = [Decoration.node(0, first.nodeSize, { class: 'ne-title-line' })];
        if (first.content.size === 0) {
          decos.push(Decoration.node(0, first.nodeSize, { class: 'ne-placeholder', 'data-placeholder': noteEditorLabels.title }));
        }
        const second = doc.childCount > 1 ? doc.child(1) : null;
        if (second && second.type === s.nodes.paragraph && second.content.size === 0 && doc.childCount === 2) {
          const from = first.nodeSize;
          decos.push(Decoration.node(from, from + second.nodeSize, { class: 'ne-placeholder', 'data-placeholder': text }));
        }
        return DecorationSet.create(doc, decos);
      },
    },
  });
}

// ---------------------------------------------------------------- сборка

export function basePlugins(placeholder: string): Plugin[] {
  return [
    buildInputRules(),
    buildKeymap(),
    keymap(baseKeymap),
    dropCursor({ class: 'ne-dropcursor' }),
    gapCursor(),
    history(),
    placeholderPlugin(placeholder),
    // Без него таблица только рисуется: нет выделения ячеек, навигации и строк-колонок
    tableEditing(),
  ];
}

export { Fragment, TextSelection };
