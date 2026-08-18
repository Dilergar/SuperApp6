'use client';

import { CloseChip, Input, ModalShell } from '@/components/ui';
import { useState, useEffect } from 'react';
import { MESSENGER_LIMITS } from '@superapp/shared';
import { ContactPicker, useContacts } from './ContactPicker';
import { EntitySelector } from '@/components/EntitySelector';
import { loadEntities, type EntityOption, type Principal } from '@/lib/entities';

type Mode = 'dm' | 'group';

/**
 * New-chat modal with a DM / Group toggle.
 *  • DM    — pick one person → onPickDm(userId).
 *  • Group — name + multi-select of Окружение → onCreateGroup(name, ids).
 * Both reuse the same ContactPicker over GET /contacts (peer id = them.id).
 */
export function NewChatModal({
  onClose,
  onPick,
  onCreateGroup,
}: {
  onClose: () => void;
  onPick: (userId: string) => void;
  onCreateGroup: (name: string, memberIds: string[]) => void;
}) {
  const { contacts, loading, error } = useContacts();
  const [mode, setMode] = useState<Mode>('dm');

  const [groupName, setGroupName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [groups, setGroups] = useState<EntityOption[]>([]);

  // Groups (Circles) are selectable in group mode and expand to their members.
  useEffect(() => { loadEntities('circle').then(setGroups).catch(() => {}); }, []);

  // People + Groups in one field. Picking a Group expands to its members
  // (snapshot) using each contact's myCircleIds — no extra request.
  const groupModeOptions: EntityOption[] = [
    ...contacts.map((c) => ({
      type: 'user', id: c.them.id,
      title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(),
      firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole,
    })),
    ...groups,
  ];

  const handleSelect = (next: Principal[]) => {
    const ids = new Set<string>();
    for (const p of next) {
      if (p.type === 'user') ids.add(p.id);
      else if (p.type === 'circle') {
        for (const c of contacts) if (c.myCircleIds?.includes(p.id)) ids.add(c.them.id);
      }
    }
    setSelected([...ids]);
  };

  const canCreate = groupName.trim().length > 0 && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    await onCreateGroup(groupName.trim(), selected);
    // Parent closes the modal on success; reset defensively.
    setCreating(false);
  };

  return (
    <ModalShell onClose={onClose} zIndex={100}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          width: '100%',
          maxWidth: '460px',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 'var(--spacing-6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 'var(--spacing-4)',
          }}
        >
          <h3 className="title-md">Новый чат</h3>
          <CloseChip onClick={onClose} />
        </div>

        {/* Mode toggle */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--spacing-1)',
            padding: '0.25rem',
            marginBottom: 'var(--spacing-4)',
            background: 'var(--surface-container)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {([['dm', 'Личный'], ['group', 'Группа']] as [Mode, string][]).map(([m, lbl]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                padding: '0.45rem 0.8rem',
                fontSize: '0.82rem',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                background: mode === m ? 'var(--surface)' : 'none',
                color: mode === m ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                boxShadow: mode === m ? 'var(--shadow-card)' : 'none',
                transition: 'background 0.15s ease',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>

        {mode === 'group' && (
          <>
            <Input
              label="Название группы"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Название группы"
              autoFocus
              maxLength={MESSENGER_LIMITS.maxGroupNameLength}
              wrapClassName="mb-3"
              style={{ fontSize: '0.95rem', fontWeight: 600 }}
            />
            <label className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>
              Участники {selected.length > 0 && <span style={{ color: 'var(--secondary)' }}>· {selected.length}</span>}
            </label>
          </>
        )}

        {mode === 'dm' ? (
          <ContactPicker
            contacts={contacts}
            loading={loading}
            error={error}
            mode="single"
            onPick={onPick}
            emptyHint="В окружении пока никого"
          />
        ) : loading ? (
          <p className="label-sm" style={{ padding: 'var(--spacing-3)' }}>Загрузка...</p>
        ) : (
          <EntitySelector
            types={['user', 'circle']}
            multi
            options={groupModeOptions}
            value={selected.map((id) => ({ type: 'user', id }))}
            onChange={handleSelect}
            placeholder="Добавить людей или Группу…"
          />
        )}

        {mode === 'group' && (
          <button
            onClick={create}
            disabled={!canCreate}
            className="btn-success"
            style={{ marginTop: 'var(--spacing-4)', fontSize: '0.9rem', opacity: canCreate ? 1 : 0.5 }}
          >
            {creating ? 'Создание...' : 'Создать группу'}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
