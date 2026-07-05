'use client';

// ============================================================
// Категории: дерево расходов/доходов до 2 уровней — раздел «Категории».
// Вынесено из page.tsx при переходе на сайдбар-разделы.
// ============================================================

import { useState } from 'react';
import type { FinAccountDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { bookParams } from './finance-lib';

export function CategoriesPanel({ categories, onChanged, bookId, canEdit }: { categories: FinAccountDto[]; onChanged: () => void; bookId: string | null; canEdit: boolean }) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = categories.filter((c) => c.kind === kind && !c.archived);
  const roots = visible.filter((c) => !c.parentId);
  const childrenOf = (id: string) => visible.filter((c) => c.parentId === id);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.post('/finance/categories', {
        kind,
        name: name.trim(),
        ...(icon.trim() ? { icon: icon.trim() } : {}),
        ...(parentId ? { parentId } : {}),
      }, bookParams(bookId));
      setName(''); setIcon(''); setParentId(''); setAdding(false);
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось создать категорию');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cat: FinAccountDto) => {
    if (!window.confirm(`Удалить категорию «${cat.name}»? Если по ней есть операции — она уйдёт в архив.`)) return;
    try {
      await api.delete(`/finance/categories/${cat.id}`, bookParams(bookId));
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось удалить');
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(0.3deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-4)' }}>
        <h2 className="title-md">Категории</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Категория'}
          </button>
        )}
      </div>

      <div className="flex" style={{ gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)' }}>
        {(['expense', 'income'] as const).map((k) => (
          <button
            key={k}
            onClick={() => { setKind(k); setParentId(''); }}
            style={{
              border: 'none',
              cursor: 'pointer',
              padding: '0.3rem 1rem',
              borderRadius: 'var(--radius-sketch)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: '0.8rem',
              background: kind === k ? 'var(--primary-container)' : 'transparent',
              color: 'var(--on-surface)',
            }}
          >
            {k === 'expense' ? 'Расходы' : 'Доходы'}
          </button>
        ))}
      </div>

      {adding && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
          <div className="grid grid-cols-[1fr_60px]" style={{ gap: 'var(--spacing-3)' }}>
            <input className="input-sketch" placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input-sketch" placeholder="🙂" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <select className="input-sketch" value={parentId} onChange={(e) => setParentId(e.target.value)} style={{ marginTop: 'var(--spacing-3)' }}>
            <option value="">Без родителя (корневая)</option>
            {roots.map((r) => <option key={r.id} value={r.id}>Внутри «{r.name}»</option>)}
          </select>
          <button className="btn-primary" style={{ marginTop: 'var(--spacing-4)', padding: '0.45rem 1.4rem', fontSize: '0.85rem' }} onClick={submit} disabled={busy}>
            Создать
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
        {roots.map((root) => (
          <div key={root.id}>
            <CategoryChip cat={root} onRemove={canEdit ? () => remove(root) : undefined} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)', margin: '0.3rem 0 0 var(--spacing-6)' }}>
              {childrenOf(root.id).map((child) => (
                <CategoryChip key={child.id} cat={child} small onRemove={canEdit ? () => remove(child) : undefined} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryChip({ cat, small, onRemove }: { cat: FinAccountDto; small?: boolean; onRemove?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="ghost-border"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: small ? '0.15rem 0.6rem' : '0.25rem 0.8rem',
        fontSize: small ? '0.75rem' : '0.85rem',
        background: 'var(--surface-container-lowest)',
      }}
    >
      <span>{cat.icon ?? '•'}</span>
      <span>{cat.name}</span>
      {hover && onRemove && (
        <button
          onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, padding: 0, lineHeight: 1 }}
          title="Удалить"
        >
          ×
        </button>
      )}
    </span>
  );
}
