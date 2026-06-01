'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar } from './messenger-ui';

// ============================================================
// Reusable picker over the user's Окружение (GET /contacts).
// `mode='single'` → one tap calls onPick(userId).
// `mode='multi'`  → checkbox/chip toggling drives a controlled
//                   `selected` set via onToggle.
// `excludeUserIds` hides people already in a group (add-members flow).
// ============================================================

export interface ContactRow {
  linkId: string;
  them: {
    id: string;
    firstName: string;
    lastName: string | null;
    avatar: string | null;
  };
  myRole: string | null;
  theirRole: string | null;
}

export function useContacts(): { contacts: ContactRow[]; loading: boolean; error: string } {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Environment list is cursor-paginated — pull all pages.
        const acc: ContactRow[] = [];
        let cursor: string | undefined;
        do {
          const res = await api.get('/contacts', { params: cursor ? { cursor } : undefined });
          acc.push(...res.data.data);
          cursor = res.data.nextCursor ?? undefined;
        } while (cursor);
        if (!cancelled) setContacts(acc);
      } catch {
        if (!cancelled) setError('Не удалось загрузить окружение');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { contacts, loading, error };
}

export function ContactPicker({
  contacts,
  loading,
  error,
  mode,
  selected = [],
  excludeUserIds = [],
  onPick,
  onToggle,
  emptyHint = 'В окружении пока никого',
}: {
  contacts: ContactRow[];
  loading: boolean;
  error: string;
  mode: 'single' | 'multi';
  selected?: string[];
  excludeUserIds?: string[];
  onPick?: (userId: string) => void;
  onToggle?: (userId: string) => void;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState('');

  const visible = useMemo(
    () => contacts.filter((c) => !excludeUserIds.includes(c.them.id)),
    [contacts, excludeUserIds],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((c) => {
      const name = `${c.them.firstName} ${c.them.lastName ?? ''}`.toLowerCase();
      const role = (c.myRole ?? '').toLowerCase();
      return name.includes(q) || role.includes(q);
    });
  }, [visible, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по имени или роли..."
        className="input-sketch"
        style={{ marginBottom: 'var(--spacing-3)', fontSize: '0.9rem' }}
      />

      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
        {loading && <p className="label-sm" style={{ padding: 'var(--spacing-3)' }}>Загрузка...</p>}
        {error && (
          <div
            className="wash-primary"
            style={{ padding: 'var(--spacing-3) var(--spacing-4)', color: 'var(--primary)', fontSize: '0.85rem' }}
          >
            {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <p className="label-sm" style={{ padding: 'var(--spacing-3)', textAlign: 'center', opacity: 0.6 }}>
            {visible.length === 0 ? emptyHint : 'Никого не найдено'}
          </p>
        )}

        {filtered.map((c) => {
          const on = selected.includes(c.them.id);
          return (
            <button
              key={c.linkId}
              type="button"
              onClick={() => (mode === 'single' ? onPick?.(c.them.id) : onToggle?.(c.them.id))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-3)',
                padding: 'var(--spacing-2) var(--spacing-3)',
                background: mode === 'multi' && on ? 'var(--secondary-container)' : 'none',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => {
                if (!(mode === 'multi' && on)) e.currentTarget.style.background = 'var(--surface-container)';
              }}
              onMouseLeave={(e) => {
                if (!(mode === 'multi' && on)) e.currentTarget.style.background = 'none';
              }}
            >
              {mode === 'multi' && (
                <span
                  aria-hidden
                  style={{
                    width: '1.15rem',
                    height: '1.15rem',
                    flexShrink: 0,
                    borderRadius: '0.4rem 0.55rem 0.45rem 0.5rem',
                    background: on ? 'var(--primary)' : 'var(--surface-container-high)',
                    color: 'var(--on-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    fontWeight: 800,
                  }}
                >
                  {on ? '✕' : ''}
                </span>
              )}
              <Avatar name={c.them.firstName} avatar={c.them.avatar} size="sm" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--on-surface)' }}>
                  {c.them.firstName} {c.them.lastName ?? ''}
                </div>
                {c.myRole && <div className="label-sm" style={{ fontSize: '0.72rem' }}>{c.myRole}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
