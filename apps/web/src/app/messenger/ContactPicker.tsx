'use client';

import { useQuery } from '@tanstack/react-query';
import type { Contact } from '@superapp/shared';
import { contactsKey, fetchAllContacts } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

// ============================================================
// Thin adapter over the shared EntitySelector, kept for the existing
// call sites (NewChat / group add / quick-actions). The old hand-rolled
// list was removed — selection now goes through the one engine.
// ============================================================

/**
 * Окружение для пикера — из ОБЩЕГО кэша React Query, а не третьей копией курсорного
 * цикла (были ещё две: `queries.fetchAllContacts` и `entities.loadUsers`, каждая со
 * своим состоянием загрузки и своим `catch`). Форма строки — shared `Contact`:
 * локальное сужение `Contact` теряло половину полей человека.
 */
export function useContacts(): { contacts: Contact[]; loading: boolean; error: string } {
  const { data, isPending, isError } = useQuery({ queryKey: contactsKey, queryFn: fetchAllContacts });
  return {
    contacts: data ?? [],
    loading: isPending,
    error: isError ? 'Не удалось загрузить окружение' : '',
  };
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
  contacts: Contact[];
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
        <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', color: 'var(--primary)', fontSize: '0.85rem', marginBottom: 'var(--spacing-2)' }}>
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
