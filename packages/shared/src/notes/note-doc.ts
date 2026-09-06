// ============================================================
// NoteDoc — СОБСТВЕННЫЙ формат документа заметки (единственная правда в БД).
//
// Это не ProseMirror-JSON и не Markdown: схема принадлежит платформе, веб-редактор
// зеркалит её в свою ProseMirror-схему (единственная точка конверсии на клиенте),
// сервер строит из неё Markdown и чистый текст (../notes/note-markdown). Любой новый
// вид блока появляется СНАЧАЛА здесь, потом в проекциях, потом в редакторе.
// ============================================================

import { z } from 'zod';
import { NOTE_LIMITS } from '../constants/notes';

// ---------------------------------------------------------------- инлайн

export type NoteSimpleMarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
export type NoteMark = { type: NoteSimpleMarkType } | { type: 'link'; attrs: { href: string } };
export type NoteMarkType = NoteMark['type'];

/**
 * Белый список схем ссылки — ЕДИНСТВЕННАЯ правда для всех путей документа (Zod
 * сохранения, парсер Markdown, вставка HTML в редактор, рендер `<a href>`).
 * `javascript:`, `data:`, `vbscript:` и прочее исполняемое = не ссылка: заметку
 * читают другие люди, и клик по ней не должен выполнять код в их сессии.
 * Скрытые управляющие символы срезаются до проверки — `java\nscript:` браузер
 * выполнит, а наивный regexp пропустит.
 */
export function isSafeNoteHref(raw: unknown): boolean {
  return normalizeNoteHref(raw) !== null;
}

/** Ссылка, годная к показу, либо null. Возвращает очищенную строку (без \0, \n, \t, BOM). */
export function normalizeNoteHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleaned || cleaned.length > NOTE_LIMITS.maxHrefLength) return null;
  // Протокол-относительная («//зло») запрещена: она уводит на чужой хост без схемы.
  if (cleaned.startsWith('//')) return null;
  if (cleaned.startsWith('/') || cleaned.startsWith('#')) return cleaned;
  return /^(https?|mailto|tel):/i.test(cleaned) ? cleaned : null;
}

export interface NoteTextNode {
  type: 'text';
  text: string;
  marks?: NoteMark[];
}
/** Упоминание человека — в интерфейсе ТОЛЬКО PersonChip (правило платформы) */
export interface NoteMentionNode {
  type: 'mention';
  attrs: { userId: string; name: string };
}
/** Вики-ссылка на другую заметку (Obsidian-ядро): обратные ссылки строятся из неё */
export interface NoteWikilinkNode {
  type: 'wikilink';
  attrs: { noteId: string; title: string };
}
/** Инлайн-тег `#тег` — теги заметки выводятся из документа сервером */
export interface NoteTagNode {
  type: 'tag';
  attrs: { name: string };
}
export interface NoteHardBreakNode {
  type: 'hardBreak';
}
export type NoteInline = NoteTextNode | NoteMentionNode | NoteWikilinkNode | NoteTagNode | NoteHardBreakNode;

// ---------------------------------------------------------------- блоки

export interface NoteParagraph {
  type: 'paragraph';
  content?: NoteInline[];
}
export interface NoteHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 };
  content?: NoteInline[];
}
export interface NoteListItem {
  type: 'listItem';
  content: NoteBlock[];
}
export interface NoteBulletList {
  type: 'bulletList';
  content: NoteListItem[];
}
export interface NoteOrderedList {
  type: 'orderedList';
  attrs?: { start?: number };
  content: NoteListItem[];
}
export interface NoteTaskItem {
  type: 'taskItem';
  attrs: { checked: boolean };
  content: NoteBlock[];
}
export interface NoteTaskList {
  type: 'taskList';
  content: NoteTaskItem[];
}
export interface NoteBlockquote {
  type: 'blockquote';
  content: NoteBlock[];
}
/** Код: только текст без разметки */
export interface NoteCodeBlock {
  type: 'codeBlock';
  attrs?: { language?: string | null };
  content?: NoteTextNode[];
}
/** Картинка — файл core/files (профиль note_image), не внешний URL */
export interface NoteImage {
  type: 'image';
  attrs: { fileId: string; alt?: string | null; width?: number | null };
}
export interface NoteHorizontalRule {
  type: 'horizontalRule';
}
export interface NoteTableCell {
  type: 'tableCell' | 'tableHeader';
  content: NoteBlock[];
}
export interface NoteTableRow {
  type: 'tableRow';
  content: NoteTableCell[];
}
export interface NoteTable {
  type: 'table';
  content: NoteTableRow[];
}

export type NoteBlock =
  | NoteParagraph
  | NoteHeading
  | NoteBulletList
  | NoteOrderedList
  | NoteTaskList
  | NoteBlockquote
  | NoteCodeBlock
  | NoteImage
  | NoteHorizontalRule
  | NoteTable;

export type NoteNode = NoteBlock | NoteInline | NoteListItem | NoteTaskItem | NoteTableRow | NoteTableCell;

export interface NoteDoc {
  type: 'doc';
  content: NoteBlock[];
}

export const emptyNoteDoc = (): NoteDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

// ---------------------------------------------------------------- Zod

const markSchema: z.ZodType<NoteMark> = z.union([
  z.object({ type: z.enum(['bold', 'italic', 'underline', 'strike', 'code']) }).strict(),
  z
    .object({
      type: z.literal('link'),
      // Схема ссылки — белым списком: `javascript:`/`data:` в чужой заметке = XSS
      attrs: z
        .object({
          href: z
            .string()
            .min(1)
            .max(NOTE_LIMITS.maxHrefLength)
            .refine(isSafeNoteHref, 'Недопустимый адрес ссылки'),
        })
        .strict(),
    })
    .strict(),
]);

const textSchema: z.ZodType<NoteTextNode> = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1),
    marks: z.array(markSchema).max(6).optional(),
  })
  .strict();

const inlineSchema: z.ZodType<NoteInline> = z.union([
  textSchema,
  z
    .object({
      type: z.literal('mention'),
      attrs: z.object({ userId: z.string().uuid(), name: z.string().min(1).max(120) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('wikilink'),
      attrs: z.object({ noteId: z.string().uuid(), title: z.string().max(NOTE_LIMITS.maxTitleLength) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tag'),
      attrs: z.object({ name: z.string().min(1).max(NOTE_LIMITS.maxTagLength) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('hardBreak') }).strict(),
]);

const inlineContent = z.array(inlineSchema).optional();

const blockSchema: z.ZodType<NoteBlock> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('paragraph'), content: inlineContent }).strict(),
    z
      .object({
        type: z.literal('heading'),
        attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
        content: inlineContent,
      })
      .strict(),
    z.object({ type: z.literal('bulletList'), content: z.array(listItemSchema).min(1) }).strict(),
    z
      .object({
        type: z.literal('orderedList'),
        attrs: z.object({ start: z.number().int().min(0).max(1_000_000).optional() }).strict().optional(),
        content: z.array(listItemSchema).min(1),
      })
      .strict(),
    z.object({ type: z.literal('taskList'), content: z.array(taskItemSchema).min(1) }).strict(),
    z.object({ type: z.literal('blockquote'), content: z.array(blockSchema).min(1) }).strict(),
    z
      .object({
        type: z.literal('codeBlock'),
        attrs: z.object({ language: z.string().max(40).nullable().optional() }).strict().optional(),
        content: z.array(textSchema).max(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('image'),
        attrs: z
          .object({
            fileId: z.string().uuid(),
            alt: z.string().max(500).nullable().optional(),
            width: z.number().int().min(40).max(4000).nullable().optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ type: z.literal('horizontalRule') }).strict(),
    z.object({ type: z.literal('table'), content: z.array(tableRowSchema).min(1) }).strict(),
  ]),
);

const listItemSchema: z.ZodType<NoteListItem> = z.lazy(() =>
  z.object({ type: z.literal('listItem'), content: z.array(blockSchema).min(1) }).strict(),
);
const taskItemSchema: z.ZodType<NoteTaskItem> = z.lazy(() =>
  z
    .object({
      type: z.literal('taskItem'),
      attrs: z.object({ checked: z.boolean() }).strict(),
      content: z.array(blockSchema).min(1),
    })
    .strict(),
);
const tableCellSchema: z.ZodType<NoteTableCell> = z.lazy(() =>
  z
    .object({
      type: z.enum(['tableCell', 'tableHeader']),
      content: z.array(blockSchema).min(1),
    })
    .strict(),
);
const tableRowSchema: z.ZodType<NoteTableRow> = z.lazy(() =>
  z.object({ type: z.literal('tableRow'), content: z.array(tableCellSchema).min(1) }).strict(),
);

/** Структурная схема документа. Размер/глубину/число узлов проверяет `validateNoteDoc`. */
export const noteDocSchema: z.ZodType<NoteDoc> = z
  .object({ type: z.literal('doc'), content: z.array(blockSchema) })
  .strict();

export type NoteDocValidation = { ok: true; nodes: number; depth: number; bytes: number } | { ok: false; reason: string };

/**
 * Полная проверка документа: структура (Zod) + лимиты платформы. Fail-closed: сервер
 * обязан звать её ПЕРЕД записью — пустой контент, бездонная вложенность или
 * мегабайты JSON не должны доезжать до БД и до чужих редакторов.
 */
export function validateNoteDoc(input: unknown): NoteDocValidation {
  // ПОРЯДОК НЕСУЩИЙ. Глубину и число узлов меряем ПЕРВЫМИ и БЕЗ рекурсии: и
  // JSON.stringify, и рекурсивная Zod-схема переполняют стек на документе в пару
  // десятков килобайт (JSON.parse принимает такой спокойно) — вместо честного 400
  // прилетал RangeError и 500. После этой проверки глубина ≤ maxDocDepth, и
  // рекурсивные шаги ниже безопасны.
  const shape = measureShape(input);
  if (!shape.ok) return shape;
  const bytes = byteLength(JSON.stringify(input));
  if (bytes > NOTE_LIMITS.maxDocBytes) return { ok: false, reason: 'Документ слишком большой' };
  const parsed = noteDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'Неверная структура документа' };
  return { ok: true, nodes: shape.nodes, depth: shape.depth, bytes };
}

/** Обход СТЕКОМ (не рекурсией): число узлов и глубина по полю `content` */
function measureShape(input: unknown): { ok: true; nodes: number; depth: number } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'Неверная структура документа' };
  }
  let nodes = 0;
  let maxDepth = 0;
  const stack: Array<{ node: object; depth: number }> = [{ node: input, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > NOTE_LIMITS.maxDocNodes) return { ok: false, reason: 'Документ слишком сложный' };
    if (depth > NOTE_LIMITS.maxDocDepth) return { ok: false, reason: 'Документ слишком сложный' };
    if (depth > maxDepth) maxDepth = depth;
    const children = (node as { content?: unknown }).content;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (child && typeof child === 'object') stack.push({ node: child as object, depth: depth + 1 });
    }
  }
  return { ok: true, nodes, depth: maxDepth };
}

/** Длина строки в байтах UTF-8 без Buffer (пакет общий для браузера и Node) */
export function byteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Каноническая сериализация для хеша содержимого: ключи объектов отсортированы,
 * поэтому одинаковые документы, собранные разными путями (редактор, Markdown-вход,
 * ИИ), дают одинаковую строку. Сам хеш считает сервер (crypto) — здесь только текст.
 */
export function canonicalNoteJson(doc: NoteDoc): string {
  return JSON.stringify(sortKeys(doc));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
