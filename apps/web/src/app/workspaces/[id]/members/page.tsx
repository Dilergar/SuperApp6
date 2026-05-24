'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceInvitation,
  WorkspaceRole,
} from '@superapp/shared';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  manager: 'Менеджер',
  staff: 'Сотрудник',
  guest: 'Гость',
};

// Owner excluded — ownership is set on creation / changed via transfer.
const ASSIGNABLE_ROLES: WorkspaceRole[] = ['admin', 'manager', 'staff', 'guest'];

/**
 * Сотрудники — separate area of the org (rendered inside the org layout).
 * Member roster + hiring (invite / cancel / remove) + leave. Manage actions
 * are owner/admin only; everyone may view the roster.
 */
export default function WorkspaceMembersPage() {
  const { isReady, user } = useRequireAuth();
  const router = useRouter();
  const { id: workspaceId } = useParams<{ id: string }>();

  const [ws, setWs] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('+7');
  const [role, setRole] = useState<WorkspaceRole>('staff');
  const [position, setPosition] = useState('');

  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [w, m] = await Promise.all([
        api.get(`/workspaces/${workspaceId}`),
        api.get(`/workspaces/${workspaceId}/members`),
      ]);
      setWs(w.data.data);
      setMembers(m.data.data);
      if (w.data.data.myRole === 'owner' || w.data.data.myRole === 'admin') {
        const inv = await api.get(`/workspaces/${workspaceId}/invitations`);
        setInvites(inv.data.data);
      } else {
        setInvites([]);
      }
    } catch {
      setError('Не удалось загрузить сотрудников');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (isReady) fetchAll();
  }, [isReady, fetchAll]);

  const invite = async () => {
    if (!/^\+7\d{10}$/.test(phone)) {
      setError('Номер в формате +7XXXXXXXXXX');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/workspaces/${workspaceId}/invitations`, {
        phone,
        role,
        position: position.trim() || undefined,
      });
      setPhone('+7');
      setPosition('');
      setRole('staff');
      await fetchAll();
    } catch (e) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Не удалось отправить приглашение';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancelInvite = async (invId: string) => {
    setBusy(true);
    try {
      await api.post(`/workspaces/${workspaceId}/invitations/${invId}/cancel`);
      await fetchAll();
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    try {
      await api.delete(`/workspaces/${workspaceId}/members/${userId}`);
      await fetchAll();
    } catch {
      setError('Не удалось удалить сотрудника');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await api.post(`/workspaces/${workspaceId}/leave`);
      router.push('/dashboard');
    } catch {
      setError('Не удалось выйти');
      setBusy(false);
    }
  };

  if (loading || !ws) {
    return <p className="label-md">Загрузка…</p>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)' }}>
        <h1 className="title-lg">Сотрудники</h1>
        <span className="label-md" style={{ fontSize: '0.85rem' }}>{ws.membersCount} чел.</span>
      </div>

      {error && (
        <p className="label-md" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-4)' }}>{error}</p>
      )}

      {/* Invite form (managers) */}
      {canManage && (
        <div className="card" style={{ marginBottom: 'var(--spacing-8)' }}>
          <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Пригласить сотрудника</h2>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7XXXXXXXXXX" className="input" style={{ width: '180px' }} />
            <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className="input" style={{ width: '170px' }}>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Должность (необязательно)" maxLength={100} className="input" style={{ flex: 1, minWidth: '180px' }} />
            <button onClick={invite} disabled={busy} className="btn-primary" style={{ padding: '0.5rem 1.25rem' }}>Пригласить</button>
          </div>
        </div>
      )}

      {/* Pending invitations (managers) */}
      {canManage && invites.length > 0 && (
        <div style={{ marginBottom: 'var(--spacing-8)' }}>
          <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Ожидают ответа</h2>
          <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
            {invites.map((inv) => (
              <div key={inv.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
                <div>
                  <span className="title-md" style={{ fontSize: '0.95rem' }}>{inv.toPhone}</span>
                  <p className="label-md" style={{ fontSize: '0.8rem' }}>
                    {ROLE_LABELS[inv.role] ?? inv.role}{inv.position ? ` · ${inv.position}` : ''}
                  </p>
                </div>
                <button onClick={() => cancelInvite(inv.id)} disabled={busy} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Отменить</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Roster */}
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {members.map((m) => (
          <div key={m.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
              <div style={{ width: '2.25rem', height: '2.25rem', borderRadius: 'var(--radius-sketch)', background: 'var(--secondary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--secondary)' }}>
                {m.userName.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="title-md" style={{ fontSize: '0.95rem' }}>
                  {m.userName}{m.userId === user?.id ? ' (вы)' : ''}
                </div>
                <p className="label-md" style={{ fontSize: '0.8rem' }}>
                  {ROLE_LABELS[m.role] ?? m.role}{m.position ? ` · ${m.position}` : ''}{m.department ? ` · ${m.department}` : ''}
                </p>
              </div>
            </div>
            {canManage && m.role !== 'owner' && m.userId !== user?.id && (
              <button onClick={() => removeMember(m.userId)} disabled={busy} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Уволить</button>
            )}
          </div>
        ))}
      </div>

      {/* Leave (non-owner) */}
      {myRole && myRole !== 'owner' && (
        <div style={{ marginTop: 'var(--spacing-10)' }}>
          <button onClick={leave} disabled={busy} className="btn-secondary" style={{ padding: '0.5rem 1.25rem', color: 'var(--primary)' }}>
            Выйти из организации
          </button>
        </div>
      )}
    </div>
  );
}
