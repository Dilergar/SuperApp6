// ============================================================
// Экстракторы и чанкер NoteDoc — чистые функции без DOM и ProseMirror.
//
// Сервер выводит из документа теги, упоминания, вики-ссылки и картинки (данные, а не
// то, что прислал клиент), заголовок «без названия» и чанки под будущие эмбеддинги.
// ============================================================

import { NOTE_LIMITS } from '../constants/notes';
import type { NoteBlock, NoteDoc, NoteInline, NoteNode } from './note-doc';
import { inlineToText } from './note-markdown';

/** Обход всех узлов документа в порядке чтения */
export function walkNoteDoc(doc: NoteDoc, visit: (node: NoteNode, depth: number) => void): void {
  const rec = (node: NoteNode, depth: number) => {
    visit(node, depth);
    const children = (node as { content?: NoteNode[] }).content;
    if (Array.isArray(children)) for (const c of children) rec(c, depth + 1);
  };
  for (const b of doc.content ?? []) rec(b, 0);
}

/** Теги — нижний регистр, уникальные, в порядке появления, с потолком */
export function extractNoteTags(doc: NoteDoc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  walkNoteDoc(doc, (n) => {
    if (n.type !== 'tag') return;
    const name = normalizeTag(n.attrs.name);
    if (!name || seen.has(name)) return;
    seen.add(name);
    if (out.length < NOTE_LIMITS.maxTags) out.push(name);
  });
  return out;
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().slice(0, NOTE_LIMITS.maxTagLength);
}

export interface NoteMentionRef {
  userId: string;
  name: string;
}

/** Упоминания людей — уникальные по userId, с потолком (лишние игнорируются, как в чате) */
export function extractNoteMentions(doc: NoteDoc): NoteMentionRef[] {
  const seen = new Set<string>();
  const out: NoteMentionRef[] = [];
  walkNoteDoc(doc, (n) => {
    if (n.type !== 'mention' || seen.has(n.attrs.userId)) return;
    seen.add(n.attrs.userId);
    if (out.length < NOTE_LIMITS.maxMentions) out.push({ userId: n.attrs.userId, name: n.attrs.name });
  });
  return out;
}

export interface NoteWikilinkRef {
  noteId: string;
  title: string;
}

export function extractNoteWikilinks(doc: NoteDoc): NoteWikilinkRef[] {
  const seen = new Set<string>();
  const out: NoteWikilinkRef[] = [];
  walkNoteDoc(doc, (n) => {
    if (n.type !== 'wikilink' || seen.has(n.attrs.noteId)) return;
    seen.add(n.attrs.noteId);
    out.push({ noteId: n.attrs.noteId, title: n.attrs.title });
  });
  return out;
}

export function extractNoteImageFileIds(doc: NoteDoc): string[] {
  const out = new Set<string>();
  walkNoteDoc(doc, (n) => {
    if (n.type === 'image') out.add(n.attrs.fileId);
  });
  return [...out];
}

/**
 * Заголовок для заметки без явного названия: первый заголовок документа, иначе
 * первая строка текста (обрезанная), иначе запасной текст.
 *
 * `fallback` пустой по умолчанию: слово «без названия» — текст ДЛЯ ЧЕЛОВЕКА, и его
 * подставляет вызывающий из каталога, а не общая утилита обеих сторон провода.
 */
export function deriveNoteTitle(doc: NoteDoc, fallback = ''): string {
  for (const b of doc.content ?? []) {
    if (b.type === 'heading') {
      const t = inlineToText(b.content ?? []).trim();
      if (t) return clip(t, 80);
    }
  }
  for (const b of doc.content ?? []) {
    const t = firstText(b);
    if (t) return clip(t, 80);
  }
  return fallback;
}

function firstText(block: NoteBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineToText(block.content ?? []).trim();
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      for (const item of block.content) for (const b of item.content) {
        const t = firstText(b);
        if (t) return t;
      }
      return '';
    case 'blockquote':
      for (const b of block.content) {
        const t = firstText(b);
        if (t) return t;
      }
      return '';
    case 'codeBlock':
      return (block.content ?? []).map((t) => t.text).join('').split('\n')[0]?.trim() ?? '';
    case 'table':
      return block.content[0]?.content.map((c) => c.content.map(firstText).join(' ')).join(' ').trim() ?? '';
    default:
      return '';
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

/** Сниппет для списка/карточки: первые N символов чистого текста без заголовка-дубля */
export function noteSnippet(plainText: string, title: string, max = NOTE_LIMITS.snippetLength): string {
  const lines = plainText.split('\n').filter(Boolean);
  if (lines.length && lines[0].trim() === title.trim()) lines.shift();
  return clip(lines.join(' · '), max);
}

// ================================================================
// Чанкинг под RAG
// ================================================================

export interface NoteChunkDraft {
  ord: number;
  /** Путь заголовков от корня: ["Собрание 5 сентября", "Решения"] */
  headingPath: string[];
  text: string;
  tokenCount: number;
}

/** Оценка токенов без токенизатора: кириллица ≈ 3 символа на токен (консервативно) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / NOTE_LIMITS.chunkCharsPerToken);
}

interface Segment {
  headingPath: string[];
  text: string;
}

/**
 * Структурный чанкинг: короткая заметка — один чанк; длинная делится по заголовкам
 * (H1–H3), внутри раздела — окнами ~400 токенов (не больше 600) с перекрытием ~60.
 * У каждого чанка — путь заголовков: контекст-префикс для эмбеддинга сервер собирает
 * из него (Contextual Retrieval).
 */
export function chunkNoteDoc(doc: NoteDoc): NoteChunkDraft[] {
  const segments = collectSegments(doc);
  const full = segments.map((s) => s.text).join('\n').trim();
  if (!full) return [];
  if (estimateTokens(full) <= NOTE_LIMITS.chunkShortNoteTokens) {
    return [{ ord: 0, headingPath: [], text: full, tokenCount: estimateTokens(full) }];
  }

  const chunks: NoteChunkDraft[] = [];
  let buf: string[] = [];
  let bufPath: string[] = [];
  let carry = '';

  const flush = () => {
    const body = buf.join('\n').trim();
    if (!body) {
      buf = [];
      return;
    }
    const text = carry ? `${carry}\n${body}` : body;
    chunks.push({ ord: chunks.length, headingPath: bufPath, text, tokenCount: estimateTokens(text) });
    carry = tail(body, NOTE_LIMITS.chunkOverlapTokens * NOTE_LIMITS.chunkCharsPerToken);
    buf = [];
  };

  for (const seg of segments) {
    const pathChanged = seg.headingPath.join('\u0000') !== bufPath.join('\u0000');
    if (pathChanged && buf.length) flush();
    if (pathChanged) {
      bufPath = seg.headingPath;
      carry = '';
    }
    // слишком длинный сегмент (одиночный абзац-простыня) — режем по предложениям
    for (const piece of splitLong(seg.text, NOTE_LIMITS.chunkMaxTokens * NOTE_LIMITS.chunkCharsPerToken)) {
      const projected = estimateTokens([...buf, piece].join('\n'));
      if (buf.length && projected > NOTE_LIMITS.chunkTargetTokens) flush();
      buf.push(piece);
      if (estimateTokens(buf.join('\n')) >= NOTE_LIMITS.chunkTargetTokens) flush();
    }
  }
  flush();
  return chunks;
}

function collectSegments(doc: NoteDoc): Segment[] {
  const out: Segment[] = [];
  const path: string[] = [];
  const visit = (blocks: NoteBlock[], inheritedPath: string[]) => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading': {
          const text = inlineToText(b.content ?? []).trim();
          path.length = Math.min(path.length, b.attrs.level - 1);
          while (path.length < b.attrs.level - 1) path.push('');
          path.push(text);
          out.push({ headingPath: [...path].filter(Boolean), text });
          break;
        }
        case 'paragraph': {
          const text = inlineToText(b.content ?? []).trim();
          if (text) out.push({ headingPath: [...inheritedPath, ...path].filter(Boolean), text });
          break;
        }
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
          for (const item of b.content) {
            const mark = b.type === 'taskList' ? ((item as { attrs?: { checked?: boolean } }).attrs?.checked ? '[x] ' : '[ ] ') : '- ';
            const inner = collectSegments({ type: 'doc', content: item.content });
            inner.forEach((s, idx) => out.push({ headingPath: [...path].filter(Boolean), text: (idx === 0 ? mark : '  ') + s.text }));
          }
          break;
        case 'blockquote':
          for (const s of collectSegments({ type: 'doc', content: b.content })) out.push({ headingPath: [...path].filter(Boolean), text: `> ${s.text}` });
          break;
        case 'codeBlock': {
          const text = (b.content ?? []).map((t) => t.text).join('').trim();
          if (text) out.push({ headingPath: [...path].filter(Boolean), text });
          break;
        }
        case 'image':
          if (b.attrs.alt) out.push({ headingPath: [...path].filter(Boolean), text: `Image: ${b.attrs.alt}` });
          break;
        case 'table':
          for (const row of b.content) {
            const text = row.content.map((c) => collectSegments({ type: 'doc', content: c.content }).map((s) => s.text).join(' ')).join(' | ');
            if (text.trim()) out.push({ headingPath: [...path].filter(Boolean), text });
          }
          break;
        case 'horizontalRule':
          break;
      }
    }
  };
  visit(doc.content ?? [], []);
  return out;
}

/** Хвост текста по границе предложения/слова — перекрытие между чанками */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(-maxChars);
  const sentence = cut.search(/[.!?]\s+/);
  if (sentence !== -1 && sentence + 2 < cut.length) return cut.slice(sentence + 2).trim();
  const word = cut.indexOf(' ');
  return (word !== -1 ? cut.slice(word + 1) : cut).trim();
}

/** Простыня без заголовков — делим по предложениям, не разрывая слова */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxChars) {
      out.push(cur);
      cur = '';
    }
    if (s.length > maxChars) {
      if (cur) out.push(cur);
      cur = '';
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Инлайн-узлы → текст (реэкспорт для потребителей экстракторов) */
export { inlineToText };
export type { NoteInline };
