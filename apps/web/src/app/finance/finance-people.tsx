'use client';

// ============================================================
// «Близкие» — быстрый список для «на кого» — раздел «Близкие».
// (Принцип 2: человек = карточка.) Вынесено из page.tsx.
// ============================================================

import { useState } from 'react';
import type { FinPersonDto } from '@superapp/shared';
import { api } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import { bookParams } from './finance-lib';

export function PeoplePanel({ people, onChanged, bookId, canEdit }: { people: FinPersonDto[]; onChanged: () => void; bookId: string | null; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);

  const add = async (userId: string) => {
    try {
      await api.post('/finance/people', { userId }, bookParams(bookId));
      setAdding(false);
      onChanged();
    } catch (e) {
      alert((e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Не удалось добавить');
    }
  };
  const remove = async (userId: string) => {
    try {
      await api.delete(`/finance/people/${userId}`, bookParams(bookId));
      onChanged();
    } catch {
      /* noop */
    }
  };

  return (
    <div className="card" style={{ transform: 'rotate(0.35deg)' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 'var(--spacing-2)' }}>
        <h2 className="title-md">Близкие</h2>
        {canEdit && (
          <button className="btn-secondary" style={{ padding: '0.25rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Скрыть' : '+ Из окружения'}
          </button>
        )}
      </div>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
        Быстрый выбор для поля «на кого» — человек об этом не узнаёт.
      </p>
      {adding && (
        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <EntitySelector value={[]} onChange={(next) => next[0] && add(next[0].id)} types={['user']} multi={false} placeholder="Кого добавить…" />
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {people.map((p) => (
          <span key={p.userId} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
            {canEdit && (
              <button
                onClick={() => remove(p.userId)}
                title="Убрать из близких"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700, padding: 0 }}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {people.length === 0 && <p className="label-md">Список пуст.</p>}
      </div>
    </div>
  );
}
