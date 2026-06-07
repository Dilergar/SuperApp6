'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MentionCandidate } from '@superapp/shared';
import { mentionToken } from '@superapp/shared';
import { getMentionable } from '@/lib/messenger-api';
import { PersonChip } from '../circles/PersonCard';

// ============================================================
// Composer with @-mention autocomplete (Phase 5).
//
// A plain <textarea> can only hold flat text, so it leaks the raw
// `@[Имя](userId)` token — UUID and all — into the input while you type
// (that was the visible bug). This composer is instead a contentEditable
// surface that renders each mention as an inline PILL showing only `@Имя`.
// The durable userId rides hidden in the pill's data-* attributes; we
// rebuild the `@[Имя](userId)` token only when serializing back to the
// parent's string value. Same model Slack / Discord / Telegram use, so
// the emitted string (and everything downstream) is byte-for-byte the same
// as before — only what the user SEES while composing changed.
//
// Contract is unchanged from the old textarea: controlled `value` (token
// string) + `onChange(next)`, `onSend`, optional typing + maxLength.
//
// React/contentEditable coexistence: the editor's children are managed
// IMPERATIVELY (createElement / innerHTML) and the JSX gives the editor
// NO children — so React's reconciler has nothing to diff and never wipes
// our DOM across re-renders (popover state, etc.). We only rebuild the DOM
// when `value` changes from OUTSIDE (mount, clear-after-send, prefill).
// ============================================================

// `@` must start the text run or follow whitespace; query has no space/@.
const TRIGGER = /(^|\s)@([^\s@]{0,30})$/;
// Mirrors @superapp/shared MENTION_TOKEN: `@[Name](uuid)`.
const TOKEN = /@\[([^\]]{1,80})\]\(([0-9a-fA-F-]{36})\)/g;

// Build the inline pill for a mention (name only — the UUID stays hidden in
// data-*). Created imperatively so it can live inside the contentEditable.
function makeChip(name: string, userId: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.setAttribute('contenteditable', 'false');
  span.dataset.mentionId = userId;
  span.dataset.mentionName = name;
  span.textContent = '@' + name;
  span.style.cssText =
    'display:inline;padding:0.05rem 0.32rem;margin:0 1px;border-radius:6px;' +
    'background:var(--secondary-container);color:var(--secondary);' +
    'font-weight:600;white-space:nowrap;';
  return span;
}

// Fill `root` with text nodes + mention pills parsed from a token string.
function buildInto(root: HTMLElement, value: string) {
  TOKEN.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(value)) !== null) {
    if (m.index > last) root.appendChild(document.createTextNode(value.slice(last, m.index)));
    root.appendChild(makeChip(m[1], m[2]));
    last = m.index + m[0].length;
  }
  if (last < value.length) root.appendChild(document.createTextNode(value.slice(last)));
}

// Serialize the editor DOM back into the `@[Имя](userId)` token string.
function domToString(root: Node): string {
  let out = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const id = el.dataset?.mentionId;
      if (id) out += mentionToken(el.dataset.mentionName ?? '', id);
      else if (el.tagName === 'BR') out += '\n';
      else out += domToString(el); // stray wrapper (e.g. from a paste) — recurse
    }
  });
  return out;
}

function placeCaretAtEnd(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function MentionInput({
  chatId,
  value,
  onChange,
  onSend,
  onTypingChange,
  placeholder,
  maxLength,
}: {
  chatId: string;
  value: string;
  /** Controlled value setter — same contract as the old <textarea onChange>. */
  onChange: (next: string) => void;
  /** Enter (no shift) with a closed popover sends. */
  onSend: () => void;
  /** Mirrors the old typing-indicator wiring: true on keystroke, false on stop. */
  onTypingChange?: (typing: boolean) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  // The string we last emitted upward — lets us tell self-edits (skip rebuild,
  // keep the caret) from external `value` changes (rebuild the DOM).
  const lastEmitted = useRef<string | null>(null);
  // Current serialized length (for the soft maxLength guard).
  const lenRef = useRef(0);

  const [isEmpty, setIsEmpty] = useState(!value);

  // Popover state.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  // Text node + char range of the active `@query` fragment we'd replace on select.
  const fragmentRef = useRef<{ node: Text; start: number; end: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCandidates([]);
    setHighlight(0);
    fragmentRef.current = null;
  }, []);

  // Read DOM → emit string upward + refresh typing / length / empty mirrors.
  const emitChange = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const str = domToString(root);
    lastEmitted.current = str;
    lenRef.current = str.length;
    setIsEmpty(str.length === 0);
    onChange(str);
    onTypingChange?.(str.trim().length > 0);
  }, [onChange, onTypingChange]);

  // Detect a live `@query` right before a collapsed caret in a text node.
  const detectTrigger = useCallback(() => {
    const root = editorRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      close();
      return;
    }
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) {
      close();
      return;
    }
    const offset = sel.anchorOffset;
    const before = (node.nodeValue ?? '').slice(0, offset);
    const m = TRIGGER.exec(before);
    if (!m) {
      close();
      return;
    }
    const q = m[2];
    // Fragment to replace = the `@` + query, ending at the caret.
    fragmentRef.current = { node: node as Text, start: offset - q.length - 1, end: offset };
    setQuery(q);
    setHighlight(0);
    setOpen(true);
  }, [close]);

  // Replace the active `@query` fragment with a mention pill + trailing space.
  const selectCandidate = useCallback(
    (c: MentionCandidate) => {
      const frag = fragmentRef.current;
      const root = editorRef.current;
      if (!frag || !root) return;
      const node = frag.node;
      const text = node.nodeValue ?? '';
      const after = text.slice(frag.end);
      node.nodeValue = text.slice(0, frag.start);
      const chip = makeChip(c.name, c.userId);
      const tail = document.createTextNode(' ' + after);
      const parent = node.parentNode;
      if (!parent) return;
      parent.insertBefore(tail, node.nextSibling);
      parent.insertBefore(chip, tail);
      // Caret right after the inserted pill + trailing space.
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(tail, 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      close();
      root.focus();
      emitChange();
    },
    [close, emitChange],
  );

  // Debounced candidate fetch (~150ms) keyed on the live query while open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      getMentionable(chatId, query)
        .then((rows) => {
          if (!cancelled) {
            setCandidates(rows);
            setHighlight(0);
          }
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, chatId]);

  // Sync DOM when `value` changes from OUTSIDE (mount, clear-after-send,
  // quick-action prefill). Self-edits set lastEmitted first, so they no-op
  // here and the caret is preserved.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const root = editorRef.current;
    if (!root) return;
    const wasActive = document.activeElement === root;
    root.innerHTML = '';
    buildInto(root, value);
    lastEmitted.current = value;
    lenRef.current = value.length;
    setIsEmpty(value.length === 0);
    if (wasActive) {
      root.focus();
      placeCaretAtEnd(root);
    }
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (open && candidates.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlight((h) => (h + 1) % candidates.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          selectCandidate(candidates[highlight]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          return;
        }
      }
      // Normal composer behavior: Enter (no shift) sends; Shift+Enter = newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
        return;
      }
      // Soft maxLength guard: block new printable chars once at the limit.
      if (
        maxLength != null &&
        lenRef.current >= maxLength &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
      }
    },
    [open, candidates, highlight, selectCandidate, close, onSend, maxLength],
  );

  const handleInput = useCallback(() => {
    emitChange();
    detectTrigger();
  }, [emitChange, detectTrigger]);

  // Keep the trigger in sync when the caret moves without editing (arrows/click).
  const handleCaretMove = useCallback(() => {
    if (open) return; // while open, keydown owns the arrows
    detectTrigger();
  }, [open, detectTrigger]);

  // Paste as plain text so no foreign HTML can enter the editor.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  return (
    <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
      {open && candidates.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 0.5rem)',
            left: 0,
            right: 0,
            maxHeight: '14rem',
            overflowY: 'auto',
            background: 'rgba(245, 245, 220, 0.92)',
            backdropFilter: 'blur(10px)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 28px rgba(198, 26, 30, 0.12)',
            padding: 'var(--spacing-2)',
            zIndex: 30,
          }}
        >
          <div
            className="label-sm"
            style={{ fontSize: '0.66rem', opacity: 0.6, padding: '0.1rem 0.4rem 0.35rem' }}
          >
            Упомянуть участника
          </div>
          {candidates.map((c, i) => (
            <button
              key={c.userId}
              type="button"
              role="option"
              aria-selected={i === highlight}
              // onMouseDown (not onClick) so the editor doesn't blur-close first.
              onMouseDown={(e) => {
                e.preventDefault();
                selectCandidate(c);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-3)',
                width: '100%',
                padding: 'var(--spacing-2) var(--spacing-3)',
                background: i === highlight ? 'var(--secondary-container)' : 'none',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <PersonChip size="M" userId={c.userId} firstName={c.name} />
            </button>
          ))}
        </div>
      )}

      {/* contentEditable has no native placeholder — overlay one while empty. */}
      {isEmpty && placeholder && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 'var(--spacing-4)',
            top: 'var(--spacing-3)',
            fontSize: '0.9rem',
            color: 'var(--on-surface-variant)',
            opacity: 0.6,
            pointerEvents: 'none',
            fontFamily: 'var(--font-body)',
          }}
        >
          {placeholder}
        </div>
      )}

      <div
        ref={editorRef}
        contentEditable
        role="textbox"
        aria-multiline
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={handleCaretMove}
        onClick={handleCaretMove}
        onPaste={handlePaste}
        onBlur={() => {
          onTypingChange?.(false);
          // Defer so a candidate's onMouseDown can fire before we close.
          setTimeout(close, 120);
        }}
        style={{
          width: '100%',
          minHeight: '2.6rem',
          maxHeight: '8rem',
          overflowY: 'auto',
          padding: 'var(--spacing-3) var(--spacing-4)',
          background: 'var(--surface)',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-body)',
          fontSize: '0.9rem',
          lineHeight: 1.45,
          color: 'var(--on-surface)',
          outline: 'none',
          boxShadow: 'inset 0 1px 4px rgba(56, 57, 45, 0.06)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          cursor: 'text',
        }}
      />
    </div>
  );
}
