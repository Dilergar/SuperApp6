'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FinShareRole } from '@superapp/shared';
import { apiDelete, apiErrorMessage, apiPost } from '@/lib/api';
import { financeSharesKey, fetchFinanceShares } from '@/lib/queries';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, Button, Divider, EmptyState, Field, IconButton, Modal, SegmentedControl, Select,
} from '@/components/ui';
import { PersonChip } from '../circles/PersonCard';
import { GroupChip } from '../circles/EntityChip';

const ROLE_OPTIONS = [
  { value: 'editor' as FinShareRole, label: 'ведёт вместе' },
  { value: 'viewer' as FinShareRole, label: 'смотрит' },
];

/** Модалка «Доступ к книге» — только для владельца.
 *  (Переключатель книг живёт над содержимым раздела — FinanceBookCard в finance-shell.tsx.) */
export function AccessModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: shares = [] } = useQuery({ queryKey: financeSharesKey(), queryFn: () => fetchFinanceShares() });
  const [role, setRole] = useState<FinShareRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: financeSharesKey() });

  const add = async (principal: { type: string; id: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/finance/shares', { principalType: principal.type, principalId: principal.id, role });
      refresh();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (principalType: string, principalId: string) => {
    try {
      await apiDelete(`/finance/shares/${principalType}/${principalId}`);
      refresh();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };
  const changeRole = async (principalType: string, principalId: string, newRole: FinShareRole) => {
    try {
      await apiPost('/finance/shares', { principalType, principalId, role: newRole });
      refresh();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Доступ к моим финансам"
      subtitle="«Смотрит» — видит всё; «ведёт вместе» — записывает и правит. Разрыв связи в Окружении отзывает доступ сам"
      size="md"
      footer={<Button variant="ghost" onClick={onClose}>Готово</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <Field label="Роль для новых">
          <SegmentedControl
            aria-label="Роль для новых"
            value={role}
            onChange={setRole}
            items={ROLE_OPTIONS.map((r) => ({ key: r.value, label: r.label }))}
          />
        </Field>

        <EntitySelector
          value={[]}
          onChange={(next) => next[0] && add(next[0])}
          types={['user', 'circle']}
          multi={false}
          placeholder="Человек или Группа…"
        />

        <Divider style={{ margin: 0 }} />

        {shares.length > 0 ? (
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            {shares.map((s) => (
              <div
                key={`${s.principalType}:${s.principalId}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}
              >
                {s.principalType === 'user' ? (
                  <PersonChip size="S" userId={s.principalId} firstName={s.name ?? 'Пользователь'} avatar={s.avatar} />
                ) : (
                  <GroupChip size="S" name={s.name ?? 'Группа'} />
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Select
                    aria-label="Роль"
                    value={s.role}
                    onChange={(v) => changeRole(s.principalType, s.principalId, v as FinShareRole)}
                    options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
                    width={170}
                  />
                  <IconButton
                    icon="close"
                    label="Отозвать доступ"
                    size={30}
                    onClick={() => remove(s.principalType, s.principalId)}
                  />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="lock"
            title="Пока никому не открыто"
            description="Выберите человека или Группу выше — книга станет видна им целиком."
          />
        )}
      </div>
    </Modal>
  );
}
