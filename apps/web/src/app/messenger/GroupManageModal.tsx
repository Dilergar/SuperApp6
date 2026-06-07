'use client';

import { useState, useEffect } from 'react';
import type { ChatDetail, ChatMemberRole, ChatParticipantInfo } from '@superapp/shared';
import { MESSENGER_LIMITS } from '@superapp/shared';
import { PersonAvatar } from './messenger-ui';
import { useContacts } from './ContactPicker';
import { EntitySelector } from '@/components/EntitySelector';
import { loadEntities, type EntityOption, type Principal } from '@/lib/entities';

const CHAT_ROLE_LABELS: Record<ChatMemberRole, string> = {
  owner: 'Владелец',
  admin: 'Админ',
  member: 'Участник',
  bot: 'Бот',
};

type Pane = 'list' | 'add';

/**
 * Group-chat management for owner/admin: participant list, rename,
 * add/remove members, grant/revoke admin (owner only), leave / delete.
 * All actions go through the api wrappers passed in; the parent invalidates
 * the chat-detail + chat-list react-query caches on each callback.
 */
export function GroupManageModal({
  detail,
  currentUserId,
  onClose,
  onRename,
  onAddMembers,
  onRemoveMember,
  onSetAdmin,
  onLeave,
  onDelete,
}: {
  detail: ChatDetail;
  currentUserId: string;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
  onAddMembers: (userIds: string[]) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onSetAdmin: (userId: string, admin: boolean) => Promise<void>;
  onLeave: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const isOwner = detail.myRole === 'owner';
  const canManage = detail.myRole === 'owner' || detail.myRole === 'admin';

  const [pane, setPane] = useState<Pane>('list');
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(detail.title);

  const { contacts, loading, error } = useContacts();
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [groups, setGroups] = useState<EntityOption[]>([]);
  useEffect(() => { loadEntities('circle').then(setGroups).catch(() => {}); }, []);

  const existingIds = detail.participants.map((p) => p.userId);
  const existingSet = new Set(existingIds);

  // People (minus current members) + Groups in one field; a Group expands to
  // its still-eligible members via myCircleIds (snapshot, no extra request).
  const addOptions: EntityOption[] = [
    ...contacts
      .filter((c) => !existingSet.has(c.them.id))
      .map((c) => ({
        type: 'user', id: c.them.id,
        title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(),
        firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole,
      })),
    ...groups,
  ];

  const handleAddSelect = (next: Principal[]) => {
    const ids = new Set<string>();
    for (const p of next) {
      if (p.type === 'user') { if (!existingSet.has(p.id)) ids.add(p.id); }
      else if (p.type === 'circle') {
        for (const c of contacts) if (c.myCircleIds?.includes(p.id) && !existingSet.has(c.them.id)) ids.add(c.them.id);
      }
    }
    setToAdd([...ids]);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => {
    const t = nameDraft.trim();
    if (!t || t === detail.title) {
      setEditingName(false);
      return;
    }
    run(() => onRename(t)).then(() => setEditingName(false));
  };

  const addSelected = () => {
    if (toAdd.length === 0) return;
    run(() => onAddMembers(toAdd)).then(() => {
      setToAdd([]);
      setPane('list');
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 110,
        background: 'rgba(56, 57, 45, 0.25)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--spacing-4)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{
          width: '100%',
          maxWidth: '480px',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 'var(--spacing-6)',
          transform: 'rotate(0.3deg)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-4)' }}>
          <div style={{ minWidth: 0 }}>
            <h3 className="title-md" style={{ marginBottom: '0.1rem' }}>
              {pane === 'add' ? 'Добавить участников' : 'Управление группой'}
            </h3>
            <p className="label-sm" style={{ fontSize: '0.75rem', opacity: 0.7 }}>
              {detail.participants.length} участник(ов)
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--on-surface-variant)', opacity: 0.5, lineHeight: 1 }}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        {pane === 'add' ? (
          <>
            {loading ? (
              <p className="label-sm" style={{ padding: 'var(--spacing-3)' }}>Загрузка...</p>
            ) : error ? (
              <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', color: 'var(--primary)', fontSize: '0.85rem' }}>{error}</div>
            ) : (
              <EntitySelector
                types={['user', 'circle']}
                multi
                options={addOptions}
                value={toAdd.map((id) => ({ type: 'user', id }))}
                onChange={handleAddSelect}
                placeholder="Добавить людей или Группу…"
              />
            )}
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-4)', justifyContent: 'flex-end' }}>
              <button onClick={() => { setPane('list'); setToAdd([]); }} className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.45rem 1rem' }}>
                Назад
              </button>
              <button
                onClick={addSelected}
                disabled={busy || toAdd.length === 0 || toAdd.length > MESSENGER_LIMITS.maxAddMembersAtOnce}
                className="btn-primary"
                style={{ fontSize: '0.85rem', padding: '0.45rem 1rem', opacity: toAdd.length ? 1 : 0.5 }}
              >
                Добавить{toAdd.length ? ` (${toAdd.length})` : ''}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Name + rename */}
            <div style={{ marginBottom: 'var(--spacing-4)' }}>
              <label className="label-md" style={{ marginBottom: 'var(--spacing-2)' }}>Название</label>
              {editingName ? (
                <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEditingName(false); setNameDraft(detail.title); } }}
                    className="input-sketch"
                    autoFocus
                    maxLength={MESSENGER_LIMITS.maxGroupNameLength}
                    style={{ flex: 1, fontSize: '0.9rem' }}
                  />
                  <button onClick={saveName} disabled={busy} className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem' }}>Сохранить</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                  <span className="title-md" style={{ fontSize: '1.05rem' }}>{detail.title}</span>
                  {canManage && (
                    <button onClick={() => { setNameDraft(detail.title); setEditingName(true); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', fontSize: '0.78rem', fontWeight: 600 }}>
                      ✎ Переименовать
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Participants */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-2)' }}>
              <label className="label-md">Участники</label>
              {canManage && (
                <button onClick={() => setPane('add')} className="btn-secondary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.8rem' }}>
                  + Добавить
                </button>
              )}
            </div>

            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)', flex: 1, minHeight: 0 }}>
              {detail.participants.map((p) => (
                <ParticipantRow
                  key={p.userId}
                  p={p}
                  isMe={p.userId === currentUserId}
                  viewerIsOwner={isOwner}
                  viewerCanManage={canManage}
                  busy={busy}
                  onRemove={() => run(() => onRemoveMember(p.userId))}
                  onSetAdmin={(admin) => run(() => onSetAdmin(p.userId, admin))}
                />
              ))}
            </div>

            {/* Footer — leave / delete */}
            <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-3)' }}>
              {isOwner ? (
                <button
                  onClick={() => { if (confirm('Удалить группу для всех? Это действие необратимо.')) run(onDelete); }}
                  disabled={busy}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.85rem', fontWeight: 600 }}
                >
                  Удалить группу
                </button>
              ) : (
                <button
                  onClick={() => { if (confirm('Покинуть группу?')) run(onLeave); }}
                  disabled={busy}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.85rem', fontWeight: 600 }}
                >
                  Покинуть группу
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ParticipantRow({
  p,
  isMe,
  viewerIsOwner,
  viewerCanManage,
  busy,
  onRemove,
  onSetAdmin,
}: {
  p: ChatParticipantInfo;
  isMe: boolean;
  viewerIsOwner: boolean;
  viewerCanManage: boolean;
  busy: boolean;
  onRemove: () => void;
  onSetAdmin: (admin: boolean) => void;
}) {
  const isTargetOwner = p.role === 'owner';
  // Owner can toggle admin on non-owner members. Owner/admin can remove non-owners (and not themselves here).
  const canToggleAdmin = viewerIsOwner && !isTargetOwner && !isMe;
  const canRemove = viewerCanManage && !isTargetOwner && !isMe;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-3)',
        padding: 'var(--spacing-2) var(--spacing-3)',
        background: 'var(--surface-container-low)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <PersonAvatar userId={p.userId} name={p.name} avatar={p.avatar} size="sm" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--on-surface)' }}>
          {p.name}{isMe && <span style={{ opacity: 0.55, fontWeight: 500 }}> (вы)</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: '0.05rem' }}>
          <span className="label-sm" style={{ fontSize: '0.7rem', color: isTargetOwner ? 'var(--tertiary)' : p.role === 'admin' ? 'var(--secondary)' : 'var(--on-surface-variant)', fontWeight: 600 }}>
            {CHAT_ROLE_LABELS[p.role]}
          </span>
          {p.roleTag && (
            <span className="label-sm" style={{ fontSize: '0.7rem', opacity: 0.7 }}>· {p.roleTag}</span>
          )}
        </div>
      </div>

      {canToggleAdmin && (
        <button
          onClick={() => onSetAdmin(p.role !== 'admin')}
          disabled={busy}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', fontSize: '0.72rem', fontWeight: 600, flexShrink: 0 }}
        >
          {p.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
        </button>
      )}
      {canRemove && (
        <button
          onClick={() => { if (confirm(`Убрать ${p.name} из группы?`)) onRemove(); }}
          disabled={busy}
          title="Убрать"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '0.95rem', flexShrink: 0, opacity: 0.7 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
