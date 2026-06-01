'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResultItem, SearchSourceType } from '@superapp/shared';
import { SEARCH_LIMITS } from '@superapp/shared';
import { searchGlobal } from '@/lib/messenger-api';
import { Avatar, formatListTime } from './messenger-ui';
import { stripMentions } from './mention-render';

// ============================================================
// Global search (Phase 6) — a search bar above the chat list.
// While a query (>= 2 chars, debounced ~250ms) is active and has
// results, grouped sections (Чаты / Люди / Сообщения) REPLACE the
// normal chat list (passed as `children`). Clearing (✕ / Escape /
// empty) restores it. Row clicks route to the parent handlers and
// then clear the search.
// ============================================================

const SECTION_LABELS: Record<SearchSourceType, string> = {
  chat: 'Чаты',
  person: 'Люди',
  message: 'Сообщения',
};
// Stable display order of the grouped sections.
const SECTION_ORDER: SearchSourceType[] = ['chat', 'person', 'message'];

export function GlobalSearch({
  onSelectChat,
  onSelectPerson,
  onSelectMessage,
  children,
}: {
  /** Chat hit → open that chat (item.id is the chatId). */
  onSelectChat: (chatId: string) => void;
  /** Person hit → open/create a DM (item.id is the userId). */
  onSelectPerson: (userId: string) => void;
  /** Message hit → deep-link (item.url is /messenger?chat=…&msg=…). */
  onSelectMessage: (url: string) => void;
  /** The normal chat list — shown when no query is active. */
  children: ReactNode;
}) {
  const [raw, setRaw] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce keystrokes ~250ms before the query fires.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  const active = debounced.length >= SEARCH_LIMITS.minQueryLength;

  const query = useQuery({
    queryKey: ['search', 'global', debounced],
    queryFn: () => searchGlobal(debounced),
    enabled: active,
  });

  const clear = () => {
    setRaw('');
    setDebounced('');
  };

  // A row was chosen → run the handler, then reset the search to the list.
  const choose = (fn: () => void) => {
    fn();
    clear();
  };

  // Has the user typed enough to show the results panel (vs. the chat list)?
  const showResults = active;
  const results = showResults ? query.data : undefined;
  const groups = useMemo(
    () => (results ? [...results.groups].sort((a, b) => SECTION_ORDER.indexOf(a.type) - SECTION_ORDER.indexOf(b.type)) : []),
    [results],
  );
  const isEmpty = showResults && !query.isLoading && results != null && results.totalCount === 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--surface-container-low)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Search bar */}
      <div style={{ padding: 'var(--spacing-3) var(--spacing-3) var(--spacing-2)' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: '0.7rem',
              fontSize: '0.9rem',
              opacity: 0.55,
              pointerEvents: 'none',
            }}
          >
            🔍
          </span>
          <input
            ref={inputRef}
            type="text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && raw) {
                e.preventDefault();
                clear();
                inputRef.current?.blur();
              }
            }}
            placeholder="Поиск по чатам, людям, сообщениям…"
            maxLength={SEARCH_LIMITS.maxQueryLength}
            aria-label="Глобальный поиск"
            style={{
              width: '100%',
              padding: '0.55rem 2.2rem 0.55rem 2.1rem',
              fontSize: '0.85rem',
              fontFamily: 'var(--font-body)',
              color: 'var(--on-surface)',
              background: 'var(--surface)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              boxShadow: '0 2px 10px rgba(56, 57, 45, 0.06)',
            }}
          />
          {raw && (
            <button
              onClick={() => {
                clear();
                inputRef.current?.focus();
              }}
              aria-label="Очистить поиск"
              title="Очистить"
              style={{
                position: 'absolute',
                right: '0.5rem',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '1rem',
                lineHeight: 1,
                color: 'var(--on-surface-variant)',
                opacity: 0.6,
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Body: results panel while searching, else the normal chat list */}
      {showResults ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 var(--spacing-2) var(--spacing-2)' }}>
          {query.isLoading && (
            <p className="label-sm" style={{ padding: 'var(--spacing-4)' }}>Поиск…</p>
          )}

          {isEmpty && (
            <div style={{ padding: 'var(--spacing-8) var(--spacing-4)', textAlign: 'center' }}>
              <p className="label-md" style={{ marginBottom: 'var(--spacing-1)' }}>Ничего не найдено</p>
              <p className="label-sm" style={{ opacity: 0.7 }}>
                По запросу «{debounced}» совпадений нет
              </p>
            </div>
          )}

          {!query.isLoading &&
            !isEmpty &&
            groups.map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.type} style={{ marginTop: 'var(--spacing-2)' }}>
                  <div
                    className="label-sm"
                    style={{
                      padding: '0.35rem var(--spacing-3) 0.2rem',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--on-surface-variant)',
                      opacity: 0.8,
                    }}
                  >
                    {SECTION_LABELS[group.type]}
                  </div>
                  {group.items.map((item) => (
                    <SearchRow
                      key={`${item.type}-${item.id}`}
                      item={item}
                      query={debounced}
                      onSelect={() => {
                        if (item.type === 'chat') choose(() => onSelectChat(item.id));
                        else if (item.type === 'person') choose(() => onSelectPerson(item.id));
                        else choose(() => onSelectMessage(item.url));
                      }}
                    />
                  ))}
                  {group.hasMore && (
                    <div
                      className="label-sm"
                      style={{
                        padding: '0.2rem var(--spacing-3) 0.4rem',
                        fontSize: '0.7rem',
                        opacity: 0.6,
                        fontStyle: 'italic',
                      }}
                    >
                      …ещё
                    </div>
                  )}
                </div>
              ),
            )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
      )}
    </div>
  );
}

// ============================================================
// One search result row — mirrors the inbox ChatRow layout
// (Avatar + title + secondary line). Message rows carry a snippet
// + relative time; chat/person rows just the title.
// ============================================================

function SearchRow({
  item,
  query,
  onSelect,
}: {
  item: SearchResultItem;
  query: string;
  onSelect: () => void;
}) {
  const isMessage = item.type === 'message';
  const secondary = isMessage ? stripMentions(item.snippet) : item.snippet ?? '';

  return (
    <button
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-3)',
        width: '100%',
        padding: 'var(--spacing-2) var(--spacing-3)',
        marginBottom: '0.15rem',
        background: 'none',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-container)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'none';
      }}
    >
      <Avatar name={item.title} avatar={item.avatar} size={isMessage ? 'sm' : 'md'} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--spacing-2)' }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: '0.88rem',
              color: 'var(--on-surface)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.title}
          </span>
          {isMessage && item.createdAt && (
            <span className="label-sm" style={{ fontSize: '0.66rem', flexShrink: 0 }}>
              {formatListTime(item.createdAt)}
            </span>
          )}
        </div>

        {secondary && (
          <div
            className="label-sm"
            style={{
              marginTop: '0.1rem',
              fontSize: '0.76rem',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {isMessage ? highlightTerm(secondary, query) : secondary}
          </div>
        )}
      </div>
    </button>
  );
}

// ============================================================
// Light case-insensitive term highlight inside a message snippet.
// Wraps the first matched run in a soft secondary-tinted span.
// ============================================================

function highlightTerm(text: string, term: string): ReactNode {
  const needle = term.trim();
  if (!needle) return text;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span
        style={{
          background: 'var(--secondary-container)',
          color: 'var(--secondary)',
          borderRadius: '0.25rem',
          padding: '0 0.12rem',
          fontWeight: 600,
        }}
      >
        {text.slice(idx, idx + needle.length)}
      </span>
      {text.slice(idx + needle.length)}
    </>
  );
}
