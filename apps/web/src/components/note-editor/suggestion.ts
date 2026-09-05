import type { EditorState } from 'prosemirror-state';

// ============================================================
// Подсказки редактора: `@` люди · `[[` заметки · `#` теги · `/` блоки.
// Триггер распознаётся по тексту абзаца перед кареткой; меню рисует React
// (SuggestionMenu), вставку делает команда редактора. Никаких DOM-хаков в
// contenteditable — только позиции документа.
// ============================================================

export type SuggestionKind = 'mention' | 'wikilink' | 'tag' | 'slash';

export interface SuggestionMatch {
  kind: SuggestionKind;
  /** Строка после триггера (без самого триггера) */
  query: string;
  /** Позиция триггера в документе (откуда заменять) */
  from: number;
  /** Позиция каретки (до куда заменять) */
  to: number;
}

// Триггер начинает текст или стоит после пробела/инлайн-узла (узлы читаются как \0).
const RULES: Array<{ kind: SuggestionKind; re: RegExp }> = [
  { kind: 'mention', re: /(^|[\s\0])@([^\s@\0]{0,40})$/u },
  { kind: 'wikilink', re: /(^|[\s\0])\[\[([^\]\0]{0,60})$/u },
  { kind: 'tag', re: /(^|[\s\0])#([\p{L}\p{N}_-]{0,40})$/u },
  { kind: 'slash', re: /(^|[\s\0])\/([\p{L}\p{N}]{0,24})$/u },
];

export function detectSuggestion(state: EditorState): SuggestionMatch | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  // Внутри кода подсказок нет
  if ($from.parent.type.spec.code) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
  for (const rule of RULES) {
    const m = rule.re.exec(textBefore);
    if (!m) continue;
    const triggerLen = rule.kind === 'wikilink' ? 2 : 1;
    const start = $from.pos - (m[2].length + triggerLen);
    return { kind: rule.kind, query: m[2], from: start, to: $from.pos };
  }
  return null;
}
