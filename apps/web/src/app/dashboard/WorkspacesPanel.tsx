'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { CompanyCard } from '../workspaces/[id]/CompanyCard';
import { PersonChip } from '../circles/PersonCard';
import type { Workspace, WorkspaceInvitation } from '@superapp/shared';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  manager: 'Менеджер',
  staff: 'Сотрудник',
  guest: 'Гость',
};

/**
 * Dashboard panel: the user's organizations (B2B) + incoming hiring invitations.
 * Clicking an organization card opens its page (the "switch into context" entry point).
 */
export function WorkspacesPanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ws, inc] = await Promise.all([
        api.get('/workspaces'),
        api.get('/workspaces/invitations/incoming'),
      ]);
      setWorkspaces(ws.data.data);
      setInvites(inc.data.data);
    } catch {
      setError('Не удалось загрузить организации');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const respond = async (id: string, action: 'accept' | 'reject') => {
    setBusyId(id);
    setError('');
    try {
      await api.post(`/workspaces/invitations/${id}/${action}`);
      await fetchAll();
    } catch {
      setError('Не удалось обработать приглашение');
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/workspaces', { name: name.trim() });
      setName('');
      setShowCreate(false);
      await fetchAll();
    } catch {
      setError('Не удалось создать организацию');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ marginBottom: 'var(--spacing-12)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--spacing-6)',
          paddingLeft: 'var(--spacing-2)',
        }}
      >
        <h2 className="title-lg">Организации</h2>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="btn-secondary"
          style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
        >
          {showCreate ? 'Отмена' : '+ Создать'}
        </button>
      </div>

      {error && (
        <p className="label-md" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-4)' }}>
          {error}
        </p>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="card" style={{ marginBottom: 'var(--spacing-6)', display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название организации"
            maxLength={100}
            className="input"
            style={{ flex: 1, minWidth: '220px' }}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button onClick={create} disabled={creating || !name.trim()} className="btn-primary" style={{ padding: '0.5rem 1.25rem' }}>
            {creating ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      )}

      {/* Incoming invitations */}
      {invites.length > 0 && (
        <div style={{ marginBottom: 'var(--spacing-6)', display: 'grid', gap: 'var(--spacing-4)' }}>
          {invites.map((inv) => (
            <div
              key={inv.id}
              className="wash-secondary"
              style={{
                padding: 'var(--spacing-5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--spacing-4)',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>Приглашение</div>
                <div className="title-md">{inv.workspaceName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap' }}>
                  <PersonChip size="S" userId={inv.invitedBy} firstName={inv.invitedByName} />
                  <span className="label-md" style={{ fontSize: '0.85rem' }}>роль: {ROLE_LABELS[inv.role] ?? inv.role}{inv.position ? ` · ${inv.position}` : ''}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                <button
                  onClick={() => respond(inv.id, 'accept')}
                  disabled={busyId === inv.id}
                  className="btn-primary"
                  style={{ padding: '0.45rem 1.1rem', fontSize: '0.85rem' }}
                >
                  Принять
                </button>
                <button
                  onClick={() => respond(inv.id, 'reject')}
                  disabled={busyId === inv.id}
                  className="btn-secondary"
                  style={{ padding: '0.45rem 1.1rem', fontSize: '0.85rem' }}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* My organizations */}
      {loading ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)' }}>Загрузка…</p>
      ) : workspaces.length === 0 ? (
        <p className="label-md" style={{ paddingLeft: 'var(--spacing-2)', opacity: 0.7 }}>
          {invites.length > 0 ? 'Примите приглашение, чтобы вступить в организацию.' : 'У вас пока нет организаций.'}
        </p>
      ) : (
        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-6)' }}>
          {workspaces.map((ws, i) => (
            <Link
              key={ws.id}
              href={`/workspaces/${ws.id}`}
              className="card-elevated"
              style={{ transform: `rotate(${i % 3 === 0 ? '-0.4' : i % 3 === 2 ? '0.4' : '0'}deg)`, display: 'block' }}
            >
              <CompanyCard ws={ws} compact />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
