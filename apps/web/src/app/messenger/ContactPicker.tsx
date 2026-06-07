'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

// ============================================================
// Thin adapter over the shared EntitySelector, kept for the existing
// call sites (NewChat / group add / quick-actions). The old hand-rolled
// list was removed — selection now goes through the one engine.
// `useContacts` still loads the environment and feeds it as options.
// ============================================================

export interface ContactRow {
  linkId: string;
  them: { id: string; firstName: string; lastName: string | null; avatar: string | null };
  myRole: string | null;
  theirRole: string | null;
  myCircleIds: string[];
}

export function useContacts(): { contacts: ContactRow[]; loading: boolean; error: string } {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
    return () => { cancelled = true; };
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
  emptyHint = 'Поиск по имени…',
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
  const options = contacts
    .filter((c) => !excludeUserIds.includes(c.them.id))
    .map((c) => ({
      type: 'user',
      id: c.them.id,
      title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(),
      firstName: c.them.firstName,
      lastName: c.them.lastName,
      role: c.myRole,
    }));

  const value: Principal[] = (mode === 'single' ? selected.slice(0, 1) : selected).map((id) => ({ type: 'user', id }));

  const handle = (next: Principal[]) => {
    if (mode === 'single') {
      onPick?.(next[next.length - 1]?.id ?? '');
      return;
    }
    // multi → translate the single add/remove delta into onToggle(id)
    const cur = new Set(selected);
    const nxt = new Set(next.map((p) => p.id));
    for (const p of next) if (!cur.has(p.id)) { onToggle?.(p.id); return; }
    for (const id of selected) if (!nxt.has(id)) { onToggle?.(id); return; }
  };

  if (loading) return <p className="label-sm" style={{ padding: 'var(--spacing-3)' }}>Загрузка...</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {error && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', color: 'var(--primary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-2)' }}>
          {error}
        </div>
      )}
      <EntitySelector
        types={['user']}
        multi={mode === 'multi'}
        options={options}
        value={value}
        onChange={handle}
        placeholder={emptyHint}
      />
    </div>
  );
}
