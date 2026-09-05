// ============================================================
// Проекции NoteDoc ⇄ Markdown и NoteDoc → чистый текст.
//
// Markdown здесь — ДИАЛЕКТ платформы поверх CommonMark/GFM: у чипов и ссылок свой
// синтаксис, чтобы проекция была без потерь и ИИ мог читать и писать заметки текстом:
//   упоминание   @[Имя](user:<uuid>)
//   вики-ссылка  [[note:<uuid>|Заголовок]]
//   тег          #тег
//   картинка     ![alt|320](file:<uuid>)   (ширина — как в Obsidian, через |)
//   чекбокс      - [ ] / - [x]
//   подчёркивание <u>…</u> (в Markdown его нет)
//
// Парсер — СВОЙ и ограниченный этим диалектом (плюс базовый CommonMark/GFM), а не
// внешняя библиотека: пакет общий для браузера и CommonJS-API, а mdast-экосистема
// ESM-only; главное же — сериализатор и парсер обязаны совпадать байт-в-байт на
// собственном выводе (round-trip проверяется сьютом).
// ============================================================

import { normalizeNoteHref } from './note-doc';
import type {
  NoteBlock,
  NoteDoc,
  NoteInline,
  NoteListItem,
  NoteMark,
  NoteTableCell,
  NoteTableRow,
  NoteTaskItem,
  NoteTextNode,
} from './note-doc';

// ================================================================
// NoteDoc → Markdown
// ================================================================

export function noteDocToMarkdown(doc: NoteDoc): string {
  const out = renderBlocks(doc.content ?? []);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + (out.length ? '\n' : '');
}

function renderBlocks(blocks: NoteBlock[]): string[] {
  const lines: string[] = [];
  blocks.forEach((block, idx) => {
    if (idx > 0) lines.push('');
    lines.push(...renderBlock(block));
  });
  return lines;
}

function renderBlock(block: NoteBlock): string[] {
  switch (block.type) {
    case 'paragraph':
      return renderParagraph(block.content ?? []);
    case 'heading':
      return [`${'#'.repeat(block.attrs.level)} ${renderInline(block.content ?? [], { oneLine: true })}`];
    case 'bulletList':
      return renderList(block.content, () => '- ');
    case 'orderedList': {
      const start = block.attrs?.start ?? 1;
      return renderList(block.content, (i) => `${start + i}. `);
    }
    case 'taskList':
      return renderList(block.content, (_i, item) => ((item as NoteTaskItem).attrs.checked ? '- [x] ' : '- [ ] '));
    case 'blockquote':
      return renderBlocks(block.content).map((l) => (l ? `> ${l}` : '>'));
    case 'codeBlock': {
      const text = (block.content ?? []).map((t) => t.text).join('');
      const fence = text.includes('```') ? '````' : '```';
      return [`${fence}${block.attrs?.language ?? ''}`, ...text.split('\n'), fence];
    }
    case 'image': {
      const alt = sanitizeBracketed(block.attrs.alt ?? '');
      const size = block.attrs.width ? `|${block.attrs.width}` : '';
      return [`![${alt}${size}](file:${block.attrs.fileId})`];
    }
    case 'horizontalRule':
      return ['---'];
    case 'table':
      return renderTable(block.content);
  }
}

function renderParagraph(content: NoteInline[]): string[] {
  const text = renderInline(content, { oneLine: false });
  return text.split('\n').map(escapeLineStart);
}

function renderList(items: Array<NoteListItem | NoteTaskItem>, marker: (i: number, item: NoteListItem | NoteTaskItem) => string): string[] {
  const lines: string[] = [];
  items.forEach((item, i) => {
    const m = marker(i, item);
    const pad = ' '.repeat(m.length);
    const [first, ...rest] = item.content;
    if (first && first.type === 'paragraph') {
      const para = renderParagraph(first.content ?? []);
      lines.push(m + (para[0] ?? ''));
      for (const l of para.slice(1)) lines.push(pad + l);
    } else {
      lines.push(m.trimEnd());
      if (first) for (const l of renderBlock(first)) lines.push(l ? pad + l : '');
    }
    for (const block of rest) {
      lines.push('');
      for (const l of renderBlock(block)) lines.push(l ? pad + l : '');
    }
  });
  return lines;
}

function renderTable(rows: NoteTableRow[]): string[] {
  if (!rows.length) return [];
  const cols = Math.max(...rows.map((r) => r.content.length));
  const renderRow = (cells: NoteTableCell[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) parts.push(cells[c] ? renderCell(cells[c]) : '');
    return `| ${parts.join(' | ')} |`;
  };
  const lines = [renderRow(rows[0].content), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(renderRow(row.content));
  return lines;
}

function renderCell(cell: NoteTableCell): string {
  return cell.content
    .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? renderInline(b.content ?? [], { oneLine: true, table: true }) : renderBlock(b).join(' ')))
    .join(' ')
    .trim();
}

interface InlineOpts {
  /** Жёсткие переносы превращаются в пробел (заголовки, ячейки) */
  oneLine: boolean;
  /** Экранировать `|` (внутри таблицы) */
  table?: boolean;
}

function renderInline(nodes: NoteInline[], opts: InlineOpts): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += renderText(node, opts);
        break;
      case 'mention':
        out += `@[${sanitizeBracketed(node.attrs.name)}](user:${node.attrs.userId})`;
        break;
      case 'wikilink':
        out += `[[note:${node.attrs.noteId}${node.attrs.title ? `|${sanitizeBracketed(node.attrs.title)}` : ''}]]`;
        break;
      case 'tag':
        out += `#${node.attrs.name}`;
        break;
      case 'hardBreak':
        out += opts.oneLine ? ' ' : '\\\n';
        break;
    }
  }
  return out;
}

const MARK_ORDER: NoteMark['type'][] = ['code', 'bold', 'italic', 'strike', 'underline', 'link'];

function renderText(node: NoteTextNode, opts: InlineOpts): string {
  const marks = node.marks ?? [];
  const has = (t: NoteMark['type']) => marks.some((m) => m.type === t);
  let s: string;
  if (has('code')) {
    const ticks = node.text.includes('`') ? '``' : '`';
    const inner = /^`|`$/.test(node.text) ? ` ${node.text} ` : node.text;
    s = `${ticks}${inner}${ticks}`;
  } else {
    s = escapeText(node.text, opts.table === true);
  }
  for (const t of MARK_ORDER) {
    if (t === 'code' || !has(t)) continue;
    if (t === 'bold') s = `**${s}**`;
    else if (t === 'italic') s = `*${s}*`;
    else if (t === 'strike') s = `~~${s}~~`;
    else if (t === 'underline') s = `<u>${s}</u>`;
    else if (t === 'link') {
      const link = marks.find((m) => m.type === 'link') as { type: 'link'; attrs: { href: string } } | undefined;
      // Документ мог быть записан до белого списка схем — небезопасный адрес
      // выводим просто текстом, а не ссылкой (проекция читается людьми и ИИ).
      const href = normalizeNoteHref(link?.attrs.href);
      if (href) s = `[${s}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
  }
  return s;
}

/** Символы, из которых парсер собирает разметку: экранируем ВСЕ, иначе проекция не без потерь */
const ESCAPE_RE = /[\\*_`[\]~<#]/g;
const ESCAPE_TABLE_RE = /[\\*_`[\]~<#|]/g;

function escapeText(text: string, inTable: boolean): string {
  return text.replace(inTable ? ESCAPE_TABLE_RE : ESCAPE_RE, (c) => `\\${c}`).replace(/\n/g, ' ');
}

/** Начало строки абзаца не должно читаться как блок (цитата, список, разделитель) */
function escapeLineStart(line: string): string {
  if (/^\s*([-+>]|\d{1,9}[.)])(\s|$)/.test(line)) return line.replace(/^(\s*)/, '$1\\');
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return `\\${line}`;
  return line;
}

/** Имена/заголовки внутри `[...]`/`(...)`/`|...|` — без разделителей синтаксиса */
function sanitizeBracketed(s: string): string {
  return s.replace(/[[\]()|\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ================================================================
// NoteDoc → чистый текст (FTS, сниппеты, эмбеддинги)
// ================================================================

export function noteDocToPlainText(doc: NoteDoc): string {
  const lines: string[] = [];
  const visit = (blocks: NoteBlock[]) => {
    for (const b of blocks) {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          lines.push(inlineToText(b.content ?? []));
          break;
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
          for (const item of b.content) visit(item.content);
          break;
        case 'blockquote':
          visit(b.content);
          break;
        case 'codeBlock':
          lines.push((b.content ?? []).map((t) => t.text).join(''));
          break;
        case 'image':
          if (b.attrs.alt) lines.push(b.attrs.alt);
          break;
        case 'horizontalRule':
          break;
        case 'table':
          for (const row of b.content) lines.push(row.content.map((c) => cellText(c)).join(' | '));
          break;
      }
    }
  };
  visit(doc.content ?? []);
  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function cellText(cell: NoteTableCell): string {
  return noteDocToPlainText({ type: 'doc', content: cell.content }).replace(/\n/g, ' ');
}

export function inlineToText(nodes: NoteInline[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.text;
    else if (n.type === 'mention') out += n.attrs.name;
    else if (n.type === 'wikilink') out += n.attrs.title;
    else if (n.type === 'tag') out += `#${n.attrs.name}`;
    else if (n.type === 'hardBreak') out += ' ';
  }
  return out;
}

// ================================================================
// Markdown → NoteDoc
// ================================================================

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Внутренний сентинел жёсткого переноса между сборщиком абзаца и инлайн-парсером */
const HARD_BREAK = String.fromCharCode(1);
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([\w+.-]*)[ \t]*$/;
const RE_QUOTE = /^ {0,3}>[ ]?(.*)$/;
const RE_LIST = /^( *)([-+*]|\d{1,9}[.)])(?:( +)(.*))?$/;
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$|^\[([ xX])\]$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Ограниченный парсер диалекта платформы (см. шапку файла) */
export function markdownToNoteDoc(markdown: string): NoteDoc {
  const src = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = src.split('\n');
  const blocks = parseBlocks(lines);
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || /^\s*$/.test(line);
}

function startsBlock(line: string): boolean {
  return RE_HEADING.test(line) || RE_HR.test(line) || RE_FENCE.test(line) || RE_QUOTE.test(line) || RE_LIST.test(line);
}

function parseBlocks(lines: string[]): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // ---- код в ограде
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const [, indent, marker, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
        if (close.test(l)) {
          i++;
          break;
        }
        body.push(l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^ +/, ''));
        i++;
      }
      const text = body.join('\n');
      blocks.push({
        type: 'codeBlock',
        attrs: { language: lang || null },
        content: text ? [{ type: 'text', text }] : undefined,
      });
      continue;
    }

    // ---- разделитель (проверяется ДО списка: `- - -` иначе читался бы как список)
    if (RE_HR.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // ---- заголовок
    const h = RE_HEADING.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3;
      const content = parseInline(h[2] ?? '');
      blocks.push({ type: 'heading', attrs: { level }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }

    // ---- цитата
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(RE_QUOTE.exec(lines[i])![1]);
        i++;
      }
      const content = parseBlocks(inner);
      blocks.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
      continue;
    }

    // ---- список
    if (RE_LIST.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(...block);
      i = next;
      continue;
    }

    // ---- таблица (строка с `|` + строка-разделитель)
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push(parseTable(rows));
      continue;
    }

    // ---- абзац: до пустой строки или начала другого блока
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
      // таблица посреди абзаца тоже начинает новый блок
      if (lines[i].includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) break;
      para.push(lines[i]);
      i++;
    }
    blocks.push(...paragraphBlocks(para));
  }
  return blocks;
}

/** Абзац: строки → инлайн (жёсткие переносы: `\` в конце строки или два пробела); картинки выносятся отдельными блоками */
function paragraphBlocks(rawLines: string[]): NoteBlock[] {
  const joined = rawLines
    .map((l, idx) => {
      const isLast = idx === rawLines.length - 1;
      const t = l.replace(/^ {0,3}/, '');
      if (isLast) return t.replace(/(\\| {2,})$/, '');
      if (/\\$/.test(t)) return t.slice(0, -1) + HARD_BREAK;
      if (/ {2,}$/.test(t)) return t.trimEnd() + HARD_BREAK;
      return t + ' ';
    })
    .join('');
  const inlines = parseInline(joined);
  const out: NoteBlock[] = [];
  let current: NoteInline[] = [];
  const flush = () => {
    const trimmed = trimInline(current);
    if (trimmed.length) out.push({ type: 'paragraph', content: trimmed });
    current = [];
  };
  for (const n of inlines) {
    if ((n as unknown as { type: string }).type === '__image') {
      flush();
      const img = n as unknown as { attrs: { fileId: string; alt: string | null; width: number | null } };
      out.push({ type: 'image', attrs: { fileId: img.attrs.fileId, alt: img.attrs.alt, width: img.attrs.width } });
    } else current.push(n);
  }
  flush();
  return out.length ? out : [{ type: 'paragraph' }];
}

/** Убираем пробелы по краям абзаца и пустые текстовые узлы */
function trimInline(nodes: NoteInline[]): NoteInline[] {
  const out = nodes.filter((n) => n.type !== 'text' || n.text.length > 0);
  if (out.length && out[0].type === 'text') out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, '') };
  const last = out.length - 1;
  if (last >= 0 && out[last].type === 'text') {
    const t = out[last] as NoteTextNode;
    out[last] = { ...t, text: t.text.replace(/\s+$/, '') };
  }
  return out.filter((n) => n.type !== 'text' || n.text.length > 0);
}

interface ListItemRaw {
  kind: 'bullet' | 'ordered' | 'task';
  checked: boolean;
  start: number;
  lines: string[];
}

function parseList(lines: string[], from: number): { block: NoteBlock[]; next: number } {
  const items: ListItemRaw[] = [];
  let i = from;
  const first = RE_LIST.exec(lines[from])!;
  const baseIndent = first[1].length;

  while (i < lines.length) {
    const m = RE_LIST.exec(lines[i]);
    if (!m || m[1].length !== baseIndent) break;
    const marker = m[2];
    const spaces = m[3] ?? ' ';
    let content = m[4] ?? '';
    const contentIndent = baseIndent + marker.length + (spaces.length > 4 ? 1 : spaces.length);
    const kindOrdered = /\d/.test(marker);
    let kind: ListItemRaw['kind'] = kindOrdered ? 'ordered' : 'bullet';
    let checked = false;
    if (!kindOrdered) {
      const t = RE_TASK.exec(content);
      if (t) {
        kind = 'task';
        checked = (t[1] ?? t[3] ?? ' ').toLowerCase() === 'x';
        content = t[2] ?? '';
      }
    }
    const itemLines: string[] = [content];
    i++;
    // продолжение элемента: отступ ≥ contentIndent, пустые строки перед таким отступом,
    // ленивое продолжение абзаца (непустая строка без признаков нового блока)
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // заглянуть вперёд: следующая непустая строка с отступом → продолжение
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && leadingSpaces(lines[j]) >= contentIndent) {
          for (; i < j; i++) itemLines.push('');
          continue;
        }
        break;
      }
      const indent = leadingSpaces(l);
      if (indent >= contentIndent) {
        itemLines.push(l.slice(contentIndent));
        i++;
        continue;
      }
      // ленивое продолжение абзаца
      const prev = itemLines[itemLines.length - 1];
      if (!isBlank(prev) && !startsBlock(l) && !RE_LIST.test(l)) {
        itemLines.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    items.push({ kind, checked, start: kindOrdered ? parseInt(marker, 10) : 1, lines: itemLines });
  }

  // соседние элементы одного вида → один список; смена вида → новый список
  const blocks: NoteBlock[] = [];
  let group: ListItemRaw[] = [];
  const flush = () => {
    if (!group.length) return;
    const kind = group[0].kind;
    if (kind === 'task') {
      blocks.push({
        type: 'taskList',
        content: group.map((it) => ({ type: 'taskItem', attrs: { checked: it.checked }, content: itemBlocks(it.lines) })),
      });
    } else if (kind === 'ordered') {
      blocks.push({
        type: 'orderedList',
        ...(group[0].start !== 1 ? { attrs: { start: group[0].start } } : {}),
        content: group.map((it) => ({ type: 'listItem', content: itemBlocks(it.lines) })),
      });
    } else {
      blocks.push({ type: 'bulletList', content: group.map((it) => ({ type: 'listItem', content: itemBlocks(it.lines) })) });
    }
    group = [];
  };
  for (const it of items) {
    if (group.length && group[0].kind !== it.kind) flush();
    group.push(it);
  }
  flush();
  return { block: blocks, next: i };
}

function itemBlocks(lines: string[]): NoteBlock[] {
  const content = parseBlocks(lines);
  return content.length ? content : [{ type: 'paragraph' }];
}

function leadingSpaces(line: string): number {
  return line.length - line.replace(/^ */, '').length;
}

function parseTable(rows: string[]): NoteBlock {
  const splitRow = (row: string): string[] => {
    const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells: string[] = [];
    let cur = '';
    for (let k = 0; k < trimmed.length; k++) {
      const c = trimmed[k];
      if (c === '\\' && k + 1 < trimmed.length) {
        cur += c + trimmed[k + 1];
        k++;
        continue;
      }
      if (c === '|') {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  };
  const header = splitRow(rows[0]);
  const cols = header.length;
  const mkCell = (text: string, head: boolean): NoteTableCell => {
    const content = parseInline(text);
    return { type: head ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', ...(content.length ? { content: trimInline(content) } : {}) }] };
  };
  const body = rows.slice(1).map((r) => {
    const cells = splitRow(r);
    while (cells.length < cols) cells.push('');
    return { type: 'tableRow' as const, content: cells.slice(0, cols).map((c) => mkCell(c, false)) };
  });
  return {
    type: 'table',
    content: [{ type: 'tableRow', content: header.map((c) => mkCell(c, true)) }, ...body],
  };
}

// ---------------------------------------------------------------- инлайн-парсер

const RE_IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const RE_MENTION = new RegExp(`^@\\[([^\\]]{1,120})\\]\\((?:user:)?(${UUID})\\)`);
const RE_WIKILINK = new RegExp(`^\\[\\[note:(${UUID})(?:\\|([^\\]]*))?\\]\\]`);
const RE_LINK = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const RE_TAG = /^#([\p{L}\p{N}_-]{1,40})/u;
const RE_ALNUM = /[\p{L}\p{N}]/u;

type InlineOut = NoteInline | { type: '__image'; attrs: { fileId: string; alt: string | null; width: number | null } };

export function parseInline(src: string): NoteInline[] {
  return parseInlineWith(src, []) as NoteInline[];
}

function parseInlineWith(src: string, marks: NoteMark[]): InlineOut[] {
  const out: InlineOut[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    pushText(out, buf, marks);
    buf = '';
  };
  const withMark = (inner: string, mark: NoteMark) => {
    flush();
    out.push(...parseInlineWith(inner, [...marks, mark]));
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);

    if (c === '\\') {
      const next = src[i + 1];
      if (next === undefined) {
        buf += c;
        i++;
      } else {
        buf += next;
        i += 2;
      }
      continue;
    }
    if (c === HARD_BREAK) {
      flush();
      out.push({ type: 'hardBreak' });
      i++;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(rest)![0];
      const closeIdx = src.indexOf(run, i + run.length);
      if (closeIdx !== -1) {
        let code = src.slice(i + run.length, closeIdx);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        flush();
        pushText(out, code, [...marks, { type: 'code' }]);
        i = closeIdx + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (rest.startsWith('**') || rest.startsWith('~~') || rest.startsWith('__')) {
      const delim = rest.slice(0, 2);
      const close = findClosing(src, i + 2, delim);
      if (close !== -1 && close > i + 2) {
        withMark(src.slice(i + 2, close), { type: delim === '~~' ? 'strike' : 'bold' });
        i = close + 2;
        continue;
      }
      buf += delim;
      i += 2;
      continue;
    }
    if (rest.startsWith('<u>')) {
      const close = src.indexOf('</u>', i + 3);
      if (close !== -1) {
        withMark(src.slice(i + 3, close), { type: 'underline' });
        i = close + 4;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const close = findClosing(src, i + 1, c);
      const inner = close !== -1 ? src.slice(i + 1, close) : '';
      const prevAlnum = i > 0 && RE_ALNUM.test(src[i - 1]);
      if (close !== -1 && inner.length && !/^\s/.test(inner) && !/\s$/.test(inner) && !(c === '_' && prevAlnum)) {
        withMark(inner, { type: 'italic' });
        i = close + 1;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const m = RE_IMAGE.exec(rest);
      if (m) {
        const [altRaw, widthRaw] = splitAltWidth(m[1]);
        if (m[2].startsWith('file:') && new RegExp(`^${UUID}$`).test(m[2].slice(5))) {
          flush();
          out.push({ type: '__image', attrs: { fileId: m[2].slice(5), alt: altRaw || null, width: widthRaw } });
        } else {
          // внешняя картинка — ссылкой (файлы заметки живут только в core/files);
          // адрес идёт через тот же белый список, что и обычная ссылка
          const href = safeHref(m[2]);
          flush();
          if (href) pushText(out, altRaw || m[2], [...marks, { type: 'link', attrs: { href } }]);
          else pushText(out, altRaw || m[2], marks);
        }
        i += m[0].length;
        continue;
      }
    }
    if (c === '@' && src[i + 1] === '[') {
      const m = RE_MENTION.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'mention', attrs: { userId: m[2].toLowerCase(), name: m[1].trim() } });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[' && src[i + 1] === '[') {
      const m = RE_WIKILINK.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'wikilink', attrs: { noteId: m[1].toLowerCase(), title: (m[2] ?? '').trim() } });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const m = RE_LINK.exec(rest);
      if (m) {
        const href = safeHref(m[2]);
        if (href) withMark(m[1], { type: 'link', attrs: { href } });
        else {
          flush();
          out.push(...parseInlineWith(m[1], marks));
        }
        i += m[0].length;
        continue;
      }
    }
    if (c === '#') {
      const prev = i > 0 ? src[i - 1] : '';
      const m = RE_TAG.exec(rest);
      if (m && !(prev && RE_ALNUM.test(prev))) {
        flush();
        out.push({ type: 'tag', attrs: { name: m[1] } });
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Ближайший закрывающий разделитель, не экранированный обратным слэшем */
function findClosing(src: string, from: number, delim: string): number {
  let k = from;
  while (k < src.length) {
    if (src[k] === '\\') {
      k += 2;
      continue;
    }
    if (src.startsWith(delim, k)) return k;
    k++;
  }
  return -1;
}

function splitAltWidth(alt: string): [string, number | null] {
  const m = /^(.*)\|(\d{2,4})$/.exec(alt);
  if (!m) return [alt.trim(), null];
  return [m[1].trim(), parseInt(m[2], 10)];
}

/**
 * Адрес ссылки из Markdown: сначала раскодировать (`%6a%61va…` — тот же
 * `javascript:`), потом сверить с белым списком схем документа. Единственный
 * разрешённый источник правды — `normalizeNoteHref` из note-doc.
 */
function safeHref(raw: string): string | null {
  let href: string;
  try {
    href = decodeURIComponent(raw);
  } catch {
    href = raw;
  }
  return normalizeNoteHref(href);
}

function pushText(out: InlineOut[], text: string, marks: NoteMark[]): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text' && sameMarks(last.marks ?? [], marks)) {
    last.text += text;
    return;
  }
  const node: NoteTextNode = { type: 'text', text };
  if (marks.length) node.marks = marks.map((m) => ({ ...m }));
  out.push(node);
}

function sameMarks(a: NoteMark[], b: NoteMark[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: NoteMark) => (m.type === 'link' ? `link:${m.attrs.href}` : m.type);
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}
