'use client';

// ============================================================
// «Близкие» — быстрый список для «на кого» — раздел «Близкие».
// (Принцип 2: человек = карточка.) Вынесено из page.tsx.
// ============================================================

import { useState } from 'react';
import type { FinPersonDto } from '@superapp/shared';
import { apiDelete, apiErrorMessage, apiPost } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { Alert, BentoGrid, Button, Card, CardHeader, EmptyState, IconButton } from '@/components/ui';
import { PersonChip } from '../circles/PersonCard';
import { bookParams } from './finance-lib';

export function PeoplePanel({
  people,
  onChanged,
  bookId,
  canEdit,
}: {
  people: FinPersonDto[];
  onChanged: () => void;
  bookId: string | null;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (userId: string) => {
    try {
      await apiPost('/finance/people', { userId }, bookParams(bookId));
      setAdding(false);
      setError(null);
      onChanged();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };
  const remove = async (userId: string) => {
    try {
      await apiDelete(`/finance/people/${userId}`, bookParams(bookId));
      onChanged();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <BentoGrid>
      <Card span={12}>
        <CardHeader
          title="Близкие"
          subtitle="Быстрый выбор для поля «на кого» — человек об этом не узнаёт"
          actions={
            canEdit ? (
              <Button variant="matte" tone="accent" size="sm" icon="userAdd" onClick={() => setAdding((v) => !v)}>
                {adding ? 'Скрыть' : 'Из окружения'}
              </Button>
            ) : undefined
          }
        />

        {error && (
          <div style={{ marginBottom: 'var(--spacing-4)' }}>
            <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>
          </div>
        )}

        {adding && canEdit && (
          <div style={{ marginBottom: 'var(--spacing-4)', maxWidth: 420 }}>
            <EntitySelector
              value={[]}
              onChange={(next) => next[0] && add(next[0].id)}
              types={['user']}
              multi={false}
              placeholder="Кого добавить…"
            />
          </div>
        )}

        {people.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {people.map((p) => (
              <span
                key={p.userId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  padding: '0.1875rem 0.3125rem 0.1875rem 0.1875rem',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-pill)',
                }}
              >
                <PersonChip size="S" userId={p.userId} firstName={p.name} avatar={p.avatar} />
                {canEdit && (
                  <IconButton icon="close" label={`Убрать ${p.name} из близких`} size={22} iconSize={12} onClick={() => remove(p.userId)} />
                )}
              </span>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="people"
            title="Список пуст"
            description="Добавьте тех, на кого чаще всего тратите — они появятся первыми в поле «на кого»."
            action={canEdit ? <Button variant="matte" icon="userAdd" onClick={() => setAdding(true)}>Выбрать из окружения</Button> : undefined}
          />
        )}
      </Card>
    </BentoGrid>
  );
}
