'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadEntities,
  ENTITY_TYPE_LABELS,
  type Principal,
  type EntityOption,
} from '@/lib/entities';
import { EntityChip } from '../app/circles/EntityChip';

// ============================================================
// EntitySelector — ONE reusable picker for any entity type (people,
// groups, later departments/positions/branches). Custom dropdown (NOT a
// native <select>, which can't render cards) with per-type chips.
// Output = principals {type,id} that core/access understands.
//
// Pattern mirrors Bitrix UI.EntitySelector / Salesforce lookup: register a
// type (loader + chip) once → every picker is consistent automatically.
// ============================================================

export function EntitySelector({
  value,
  onChange,
  types = ['user'],
  multi = true,
  placeholder = 'Начните вводить имя…',
  options,
}: {
  value: Principal[];
  onChange: (next: Principal[]) => void;
  types?: string[];
  multi?: boolean;
  placeholder?: string;
  /** Custom option set (a context-specific dataset) instead of the global registry. */
  options?: EntityOption[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [loaded, setLoaded] = useState<EntityOption[]>([]);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const typesKey = types.join(',');

  // Load from the global registry unless a custom option set was provided.
  useEffect(() => {
    if (options) return;
    let ok = true;
    Promise.all(types.map((t) => loadEntities(t)))
      .then((lists) => { if (ok) setLoaded(lists.flat()); })
      .catch(() => {});
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesKey, options]);

  const opts = options ?? loaded;

  // Close on outside click.
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const key = (p: { type: string; id: string }) => `${p.type}:${p.id}`;
  const selectedKeys = useMemo(() => new Set(value.map(key)), [value]);
  const byKey = useMemo(() => new Map(opts.map((o) => [key(o), o])), [opts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return opts.filter((o) => !selectedKeys.has(key(o)) && (!needle || o.title.toLowerCase().includes(needle)));
  }, [opts, q, selectedKeys]);

  const groups = useMemo(
    () => types.map((t) => ({ type: t, items: filtered.filter((o) => o.type === t) })).filter((g) => g.items.length),
    [types, filtered],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => { setHi(0); }, [q, open]);

  const add = (o: EntityOption) => {
    const p: Principal = { type: o.type, id: o.id };
    onChange(multi ? [...value, p] : [p]);
    setQ('');
    if (!multi) setOpen(false);
  };
  const remove = (p: Principal) => onChange(value.filter((x) => !(x.type === p.type && x.id === p.id)));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open && flat[hi]) { e.preventDefault(); add(flat[hi]); } }
    else if (e.key === 'Escape') { setOpen(false); }
    else if (e.key === 'Backspace' && q === '' && value.length) { remove(value[value.length - 1]); }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Field: selected chips + search input */}
      <div
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem',
          padding: '0.4rem 0.5rem', minHeight: '2.4rem', cursor: 'text',
          background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-md)',
          boxShadow: open ? '0 0 0 2px var(--secondary)' : '0 0 0 1.5px var(--outline-variant)',
          transition: 'box-shadow 0.15s ease',
        }}
      >
        {value.map((p) => {
          const o = byKey.get(key(p)) ?? { type: p.type, id: p.id, title: '…' };
          return (
            <span key={key(p)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem' }}>
              <EntityChip entity={o} size="S" />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(p); }}
                title="Убрать"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)', fontSize: '0.9rem', lineHeight: 1, padding: '0 0.15rem' }}
              >×</button>
            </span>
          );
        })}
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? '' : placeholder}
          style={{ flex: 1, minWidth: '8rem', border: 'none', outline: 'none', background: 'transparent', fontSize: '0.9rem', color: 'var(--on-surface)', padding: '0.2rem' }}
        />
      </div>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            marginTop: 4, maxHeight: 340, overflowY: 'auto', padding: 'var(--spacing-2)',
            background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-md)',
            boxShadow: '0 12px 36px rgba(56,57,45,0.16)',
          }}
        >
          {flat.length === 0 ? (
            <div className="label-sm" style={{ padding: 'var(--spacing-2)', opacity: 0.6 }}>Ничего не найдено</div>
          ) : (
            groups.map((g) => (
              <div key={g.type} style={{ marginBottom: '0.3rem' }}>
                {types.length > 1 && (
                  <div className="label-sm" style={{ fontSize: '0.66rem', opacity: 0.55, padding: '0.2rem 0.3rem' }}>
                    {ENTITY_TYPE_LABELS[g.type] ?? g.type}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {g.items.map((o) => {
                    const idx = flat.indexOf(o);
                    return (
                      <button
                        key={key(o)}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); add(o); }}
                        onMouseEnter={() => setHi(idx)}
                        style={{
                          display: 'inline-flex', border: 'none', cursor: 'pointer',
                          padding: '0.2rem', borderRadius: 'var(--radius-sm)',
                          background: idx === hi ? 'var(--surface-container)' : 'transparent',
                        }}
                      >
                        <EntityChip entity={o} size="M" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
