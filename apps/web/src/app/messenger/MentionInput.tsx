'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MentionCandidate } from '@superapp/shared';
import { mentionToken } from '@superapp/shared';
import { getMentionable } from '@/lib/messenger-api';
import { Avatar } from './messenger-ui';

// ============================================================
// Composer textarea with @-mention autocomplete (Phase 5).
//
// Trigger detection: look at the substring BEFORE the caret and match
// /@([^\s@]{0,30})$/ — an `@` (after start/whitespace) followed by query
// chars right up to the cursor. While active, debounce-fetch the chat's
// mentionable members and show a popover ABOVE the composer.
//
// Selection (click / Enter / Tab) replaces the `@query` fragment with
// `@[Имя](userId) ` and closes. Arrows move the highlight; Escape closes.
//
// All the normal composer keys (Enter-to-send, Shift+Enter newline,
// typing-indicator onChange, blur-stop) are preserved — they only yield
// to the popover while it is open.
// ============================================================

// `@` must start the message or follow whitespace; query has no space/@.
const TRIGGER = /(^|\s)@([^\s@]{0,30})$/;

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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Popover state.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [highlight, setHighlight] = useState(0);
  // Char range of the `@query` fragment we'd replace on select.
  const fragmentRef = useRef<{ start: number; end: number } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCandidates([]);
    setHighlight(0);
    fragmentRef.current = null;
  }, []);

  // Re-evaluate the trigger from the text + caret position.
  const detectTrigger = useCallback((text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = TRIGGER.exec(before);
    if (!m) {
      close();
      return;
    }
    const q = m[2];
    // Fragment to replace = the `@` + query, ending at the caret.
    const start = caret - q.length - 1; // -1 for the '@'
    fragmentRef.current = { start, end: caret };
    setQuery(q);
    setHighlight(0);
    setOpen(true);
  }, [close]);

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

  // Insert the token for `c`, replacing the active `@query` fragment.
  const selectCandidate = useCallback(
    (c: MentionCandidate) => {
      const frag = fragmentRef.current;
      const ta = taRef.current;
      if (!frag) return;
      const token = mentionToken(c.name, c.userId) + ' ';
      const next = value.slice(0, frag.start) + token + value.slice(frag.end);
      onChange(next);
      onTypingChange?.(next.trim().length > 0);
      close();
      // Restore caret right after the inserted token + trailing space.
      const caret = frag.start + token.length;
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          ta.setSelectionRange(caret, caret);
        }
      });
    },
    [value, onChange, onTypingChange, close],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      onChange(text);
      onTypingChange?.(text.trim().length > 0);
      detectTrigger(text, e.target.selectionStart ?? text.length);
    },
    [onChange, onTypingChange, detectTrigger],
  );

  // Keep the trigger in sync when the caret moves without editing (click / arrows).
  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;
      detectTrigger(ta.value, ta.selectionStart ?? ta.value.length);
    },
    [detectTrigger],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      }
    },
    [open, candidates, highlight, selectCandidate, close, onSend],
  );

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
              // onMouseDown (not onClick) so the textarea doesn't blur-close first.
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
              <Avatar name={c.name} avatar={c.avatar} size="sm" />
              <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--on-surface)' }}>
                {c.name}
              </span>
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          onTypingChange?.(false);
          // Defer so a candidate's onMouseDown can fire before we close.
          setTimeout(close, 120);
        }}
        placeholder={placeholder}
        rows={1}
        maxLength={maxLength}
        style={{
          width: '100%',
          resize: 'none',
          maxHeight: '8rem',
          minHeight: '2.6rem',
          padding: 'var(--spacing-3) var(--spacing-4)',
          background: 'var(--surface)',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-body)',
          fontSize: '0.9rem',
          color: 'var(--on-surface)',
          outline: 'none',
          boxShadow: 'inset 0 1px 4px rgba(56, 57, 45, 0.06)',
        }}
      />
    </div>
  );
}
