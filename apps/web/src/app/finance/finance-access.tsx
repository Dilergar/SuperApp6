'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
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

const ROLE_VALUES: FinShareRole[] = ['editor', 'viewer'];

/** Модалка «Доступ к книге» — только для владельца.
 *  (Переключатель книг живёт над содержимым раздела — FinanceBookCard в finance-shell.tsx.) */
export function AccessModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const t = useTranslations('finance');
  const common = useTranslations('common');
  // Подпись роли собирается по ЗНАЧЕНИЮ (`finance.role.<role>`) — те же слова,
  // что сервер кладёт в уведомление о шеринге.
  const roleOptions = ROLE_VALUES.map((value) => ({ value, label: t(`role.${value}`) }));
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
      title={t('access.title')}
      subtitle={t('access.subtitle')}
      size="md"
      footer={<Button variant="ghost" onClick={onClose}>{common('actions.done')}</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}

        <Field label={t('access.roleForNew')}>
          <SegmentedControl
            aria-label={t('access.roleForNew')}
            value={role}
            onChange={setRole}
            items={roleOptions.map((r) => ({ key: r.value, label: r.label }))}
          />
        </Field>

        <EntitySelector
          value={[]}
          onChange={(next) => next[0] && add(next[0])}
          types={['user', 'circle']}
          multi={false}
          placeholder={t('access.pickPlaceholder')}
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
                  <PersonChip size="S" userId={s.principalId} firstName={s.name ?? common('labels.someone')} avatar={s.avatar} />
                ) : (
                  <GroupChip size="S" name={s.name ?? t('access.group')} />
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Select
                    aria-label={t('access.role')}
                    value={s.role}
                    onChange={(v) => changeRole(s.principalType, s.principalId, v as FinShareRole)}
                    options={roleOptions}
                    width={170}
                  />
                  <IconButton
                    icon="close"
                    label={t('access.revoke')}
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
            title={t('access.emptyTitle')}
            description={t('access.emptyDescription')}
          />
        )}
      </div>
    </Modal>
  );
}
