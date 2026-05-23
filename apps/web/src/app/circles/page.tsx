'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { PersonCard } from './PersonCard';
import { ROLE_PRESETS } from '@superapp/shared';
import type {
  Contact,
  IncomingInvitation,
  OutgoingInvitation,
  Circle,
  CircleWithMembers,
  CardVisibility,
} from '@superapp/shared';

// ============================================================
// Constants
// ============================================================

const GROUP_TEMPLATES = [
  { name: 'Семья', color: '#ffaca3' },
  { name: 'Родственники', color: '#ffccbc' },
  { name: 'Друзья', color: '#c7e7ff' },
  { name: 'Коллеги', color: '#ffe08c' },
  { name: 'Одноклассники', color: '#c8e6c9' },
  { name: 'Университет', color: '#e1bee7' },
];

const GROUP_COLORS = [
  '#ffaca3', '#c7e7ff', '#ffe08c', '#c8e6c9',
  '#e1bee7', '#ffccbc', '#b2dfdb', '#f0f4c3',
];

type VisField =
  | 'city' | 'bio' | 'dateOfBirth' | 'age'
  | 'maritalStatus' | 'email' | 'socialLinks' | 'onlineStatus';

const VIS_FIELDS: { key: VisField; label: string }[] = [
  { key: 'city', label: 'Город' },
  { key: 'bio', label: 'О себе' },
  { key: 'dateOfBirth', label: 'Дата рождения' },
  { key: 'age', label: 'Возраст' },
  { key: 'maritalStatus', label: 'Семейное положение' },
  { key: 'email', label: 'Email' },
  { key: 'socialLinks', label: 'Соцсети' },
  { key: 'onlineStatus', label: 'Онлайн-статус' },
];

// ============================================================
// Main page
// ============================================================

export default function CirclesPage() {
  const { isReady } = useRequireAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Circle[]>([]);
  const [incoming, setIncoming] = useState<IncomingInvitation[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [invPhone, setInvPhone] = useState('+7');
  const [invLookup, setInvLookup] = useState<{ id: string; firstName: string; lastName: string | null; phone: string } | null>(null);
  const [invLookupLoading, setInvLookupLoading] = useState(false);
  const [invLookupDone, setInvLookupDone] = useState(false);
  const [invTheyForMe, setInvTheyForMe] = useState('');
  const [invMeForThem, setInvMeForThem] = useState('');
  const [invMessage, setInvMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Group create
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupColor, setGroupColor] = useState(GROUP_COLORS[0]);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Group filter — null = show all, string = filter by group
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [activeGroupData, setActiveGroupData] = useState<CircleWithMembers | null>(null);

  // Invitations panel
  const [showInvitations, setShowInvitations] = useState(true);

  const clear = () => { setError(''); setSuccessMsg(''); };

  // ============================================================
  // Data fetching
  // ============================================================

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      // Environment list is cursor-paginated server-side; pull all pages so
      // the UI keeps showing everyone, while each request stays bounded.
      const loadAllContacts = async (): Promise<Contact[]> => {
        const acc: Contact[] = [];
        let cursor: string | undefined;
        do {
          const res = await api.get('/contacts', {
            params: cursor ? { cursor } : undefined,
          });
          acc.push(...res.data.data);
          cursor = res.data.nextCursor ?? undefined;
        } while (cursor);
        return acc;
      };

      const [c, inc, out, f] = await Promise.all([
        loadAllContacts(),
        api.get('/contacts/invitations/incoming'),
        api.get('/contacts/invitations/outgoing'),
        api.get('/circles'),
      ]);
      setContacts(c);
      setIncoming(inc.data.data);
      setOutgoing(out.data.data);
      setGroups(f.data.data);
    } catch {
      setError('Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isReady) fetchAll();
  }, [isReady, fetchAll]);

  const selectGroup = async (groupId: string | null) => {
    if (groupId === null) {
      setActiveGroup(null);
      setActiveGroupData(null);
      return;
    }
    try {
      const { data } = await api.get(`/circles/${groupId}`);
      setActiveGroup(groupId);
      setActiveGroupData(data.data);
    } catch {
      setError('Не удалось загрузить группу');
    }
  };

  // ============================================================
  // Invitation actions
  // ============================================================

  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePhoneLookup = (phone: string) => {
    setInvPhone(phone);
    setInvLookup(null);
    setInvLookupDone(false);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (phone.length >= 12) {
      setInvLookupLoading(true);
      lookupTimer.current = setTimeout(async () => {
        try {
          const { data } = await api.get(`/users/lookup?phone=${encodeURIComponent(phone)}`);
          setInvLookup(data.data);
          setInvLookupDone(true);
        } catch {
          setInvLookupDone(true);
        } finally {
          setInvLookupLoading(false);
        }
      }, 500);
    }
  };

  useEffect(() => {
    return () => { if (lookupTimer.current) clearTimeout(lookupTimer.current); };
  }, []);

  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    clear();
    setSending(true);
    try {
      const payload: Record<string, unknown> = { toPhone: invPhone };
      // invTheyForMe = role I give them; invMeForThem = role I suggest they give me.
      if (invTheyForMe.trim()) payload.proposedRoleForRecipient = invTheyForMe.trim();
      if (invMeForThem.trim()) payload.proposedRoleForSender = invMeForThem.trim();
      if (invMessage.trim()) payload.message = invMessage.trim();

      await api.post('/contacts/invitations', payload);
      setSuccessMsg('Приглашение отправлено!');
      setShowInvite(false);
      setInvPhone('+7');
      setInvLookup(null);
      setInvLookupDone(false);
      setInvTheyForMe('');
      setInvMeForThem('');
      setInvMessage('');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const handleAccept = async (invId: string) => {
    clear();
    try {
      await api.post(`/contacts/invitations/${invId}/accept`, {});
      setSuccessMsg('Приглашение принято!');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleReject = async (invId: string) => {
    clear();
    try {
      await api.post(`/contacts/invitations/${invId}/reject`);
      setSuccessMsg('Приглашение отклонено');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleCancel = async (invId: string) => {
    clear();
    try {
      await api.post(`/contacts/invitations/${invId}/cancel`);
      setSuccessMsg('Приглашение отменено');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleDeleteContact = async (linkId: string) => {
    clear();
    try {
      await api.delete(`/contacts/${linkId}`);
      setSuccessMsg('Связь удалена');
      await fetchAll();
      if (activeGroup) selectGroup(activeGroup);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  // ============================================================
  // Group actions
  // ============================================================

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    clear();
    setCreatingGroup(true);
    try {
      await api.post('/circles', { name: groupName.trim(), color: groupColor });
      setGroupName('');
      setShowCreateGroup(false);
      setSuccessMsg('Группа создана');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    clear();
    try {
      await api.delete(`/circles/${groupId}`);
      if (activeGroup === groupId) { setActiveGroup(null); setActiveGroupData(null); }
      setSuccessMsg('Группа удалена');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleAddToGroup = async (contactLinkId: string, groupId: string) => {
    clear();
    try {
      await api.post(`/circles/${groupId}/members`, { contactLinkId });
      await fetchAll();
      if (activeGroup === groupId) selectGroup(groupId);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleRemoveFromGroup = async (linkId: string) => {
    if (!activeGroup) return;
    clear();
    try {
      await api.delete(`/circles/${activeGroup}/members/${linkId}`);
      await fetchAll();
      selectGroup(activeGroup);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  // Optimistically reflect a group's saved visibility.
  const handleGroupVisibilitySaved = (updated: Circle) => {
    setGroups((prev) => prev.map((g) => (g.id === updated.id ? { ...g, ...updated } : g)));
    setActiveGroupData((prev) =>
      prev && prev.id === updated.id ? { ...prev, ...updated } : prev,
    );
    setSuccessMsg('Видимость группы сохранена');
  };

  // ============================================================
  // Render
  // ============================================================

  if (!isReady || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  const totalInvitations = incoming.length + outgoing.length;
  const displayedContacts = activeGroup && activeGroupData
    ? activeGroupData.members
    : contacts;
  const activeGroupObj = activeGroup ? groups.find((g) => g.id === activeGroup) : null;

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/profile" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Профиль</Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Главная</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>

        {/* Header */}
        <div style={{ marginBottom: 'var(--spacing-6)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>Моё окружение</h1>
            <p className="label-md" style={{ fontSize: '0.95rem' }}>
              {contacts.length} {pluralize(contacts.length, 'человек', 'человека', 'человек')}
            </p>
          </div>
          <button onClick={() => { setShowInvite(!showInvite); clear(); }} className="btn-primary" style={{ fontSize: '0.9rem', padding: '0.5rem 1.2rem' }}>
            {showInvite ? 'Отмена' : '+ Добавить'}
          </button>
        </div>

        {/* Messages */}
        {error && (
          <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}
        {successMsg && (
          <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>
            {successMsg}
          </div>
        )}

        {/* Invite form */}
        {showInvite && (
          <form onSubmit={handleSendInvitation} className="card-elevated" style={{ marginBottom: 'var(--spacing-8)', padding: 'var(--spacing-6)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Добавить в окружение</h3>

            <div style={{ marginBottom: 'var(--spacing-4)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Номер телефона</label>
              <input type="tel" value={invPhone} onChange={(e) => handlePhoneLookup(e.target.value)} placeholder="+77001234567" className="input-sketch" autoFocus />
            </div>

            {invLookupLoading && <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>Поиск...</p>}
            {invLookupDone && invLookup && (
              <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                <Avatar name={invLookup.firstName} size="sm" />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{invLookup.firstName} {invLookup.lastName || ''}</div>
                  <div className="label-sm">{invLookup.phone}</div>
                </div>
              </div>
            )}
            {invLookupDone && !invLookup && (
              <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>
                Пользователь не найден — приглашение уйдёт на этот номер
              </div>
            )}

            {/* Roles — your role + their role (presets + custom) */}
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
              <RolePicker
                label="Моя роль (как он(а) видит меня)"
                value={invMeForThem}
                onChange={setInvMeForThem}
              />
              <RolePicker
                label={invLookup ? `Роль: ${invLookup.firstName}` : 'Его(её) роль'}
                value={invTheyForMe}
                onChange={setInvTheyForMe}
              />
            </div>

            <div style={{ marginBottom: 'var(--spacing-6)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Сообщение</label>
              <input type="text" value={invMessage} onChange={(e) => setInvMessage(e.target.value)} placeholder="Привет! Давай добавимся..." className="input-sketch" />
            </div>

            <button type="submit" disabled={sending || invPhone.length < 12} className="btn-primary" style={{ fontSize: '0.9rem', opacity: (sending || invPhone.length < 12) ? 0.6 : 1 }}>
              {sending ? 'Отправка...' : 'Отправить приглашение'}
            </button>
          </form>
        )}

        {/* Pending invitations */}
        <div style={{ marginBottom: 'var(--spacing-6)' }}>
          <button
            onClick={() => setShowInvitations(!showInvitations)}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)',
              background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.95rem',
              color: 'var(--on-surface)', marginBottom: showInvitations ? 'var(--spacing-3)' : 0,
            }}
          >
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--primary-container)', color: 'var(--primary)',
              borderRadius: '0.5rem', padding: '0.1rem 0.5rem', fontSize: '0.75rem', fontWeight: 700,
            }}>
              {totalInvitations}
            </span>
            Приглашения
            <span style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)', marginLeft: '0.2rem' }}>
              {showInvitations ? '▲' : '▼'}
            </span>
          </button>

          {showInvitations && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
              {totalInvitations === 0 && (
                <p className="label-sm" style={{ padding: 'var(--spacing-2) 0' }}>Нет приглашений</p>
              )}
              {incoming.map((inv) => (
                <InvitationCard key={inv.id} inv={inv} direction="incoming"
                  myRole={inv.proposedRoleForRecipient} theirRole={inv.proposedRoleForSender}
                  theirName={inv.from?.firstName || '?'}
                  theirPhone={inv.toPhone}
                  onAccept={() => handleAccept(inv.id)} onReject={() => handleReject(inv.id)} />
              ))}
              {outgoing.map((inv) => (
                <InvitationCard key={inv.id} inv={inv} direction="outgoing"
                  myRole={inv.proposedRoleForSender} theirRole={inv.proposedRoleForRecipient}
                  theirName={inv.to?.firstName || inv.toPhone}
                  theirPhone={inv.toPhone}
                  registered={!!inv.to}
                  onCancel={() => handleCancel(inv.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Group chips — filter bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
          <button
            onClick={() => selectGroup(null)}
            style={{
              padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
              border: 'none', cursor: 'pointer', fontWeight: 600,
              background: activeGroup === null ? 'var(--surface-container-lowest)' : 'var(--surface-container)',
              color: activeGroup === null ? 'var(--on-surface)' : 'var(--on-surface-variant)',
              boxShadow: activeGroup === null ? '0 2px 12px rgba(56, 57, 45, 0.08)' : 'none',
            }}
          >
            Все
          </button>

          {groups.map((g) => (
            <div key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
              <button
                onClick={() => selectGroup(g.id)}
                style={{
                  padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                  border: 'none', cursor: 'pointer', fontWeight: 500,
                  background: activeGroup === g.id ? (g.color || 'var(--secondary-container)') : 'var(--surface-container)',
                  color: activeGroup === g.id ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  opacity: activeGroup === g.id ? 1 : 0.8,
                }}
              >
                {g.name}
                <span style={{ marginLeft: '0.3rem', fontSize: '0.65rem', opacity: 0.6 }}>{g.membersCount}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Удалить группу "${g.name}"?`)) handleDeleteGroup(g.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: 'var(--outline)', opacity: 0.3, padding: '0 0.15rem' }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.3'; }}
                title="Удалить группу"
              >×</button>
            </div>
          ))}

          <button
            onClick={() => setShowCreateGroup(!showCreateGroup)}
            style={{
              padding: '0.3rem 0.6rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sketch)',
              border: '1.5px dashed var(--outline-variant)', background: 'transparent',
              cursor: 'pointer', color: 'var(--on-surface-variant)', fontWeight: 500,
            }}
          >
            + Группа
          </button>
        </div>

        {/* Create group form */}
        {showCreateGroup && (
          <form onSubmit={handleCreateGroup} className="card" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '150px' }}>
                <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Название группы</label>
                <input type="text" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Семья, Родственники..." className="input-sketch" autoFocus style={{ fontSize: '0.85rem' }} />
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
                {GROUP_COLORS.slice(0, 6).map((color) => (
                  <button key={color} type="button" onClick={() => setGroupColor(color)}
                    style={{
                      width: '1.4rem', height: '1.4rem', borderRadius: '0.4rem',
                      background: color, border: groupColor === color ? '2px solid var(--primary)' : '1px solid transparent',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
              <button type="submit" disabled={creatingGroup || !groupName.trim()} className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.3rem 0.8rem' }}>
                Создать
              </button>
              <button type="button" onClick={() => setShowCreateGroup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
                Отмена
              </button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              {GROUP_TEMPLATES.map((t) => (
                <button key={t.name} type="button" onClick={() => { setGroupName(t.name); setGroupColor(t.color); }}
                  style={{
                    padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: 'var(--radius-sm)',
                    border: 'none', cursor: 'pointer', background: t.color, opacity: 0.6, fontWeight: 500,
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </form>
        )}

        {/* Per-group visibility editor (only when a group is selected) */}
        {activeGroupObj && (
          <GroupVisibilityEditor
            key={activeGroupObj.id}
            group={activeGroupObj}
            onSaved={handleGroupVisibilitySaved}
          />
        )}

        {/* People list */}
        {displayedContacts.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}>
            <p className="label-md">
              {activeGroup ? 'В этой группе пока никого' : 'Пока никого в окружении'}
            </p>
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>
              {activeGroup ? 'Добавьте людей из окружения' : "Нажмите '+ Добавить' чтобы пригласить"}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--spacing-6)' }}>
            {displayedContacts.map((c) => (
              <PersonCard
                key={c.linkId}
                contact={c}
                folders={groups}
                activeFolder={activeGroup}
                onDelete={() => { if (confirm('Удалить из окружения? Это действие двустороннее.')) handleDeleteContact(c.linkId); }}
                onRemoveFromFolder={() => handleRemoveFromGroup(c.linkId)}
                onAddToFolder={(groupId) => handleAddToGroup(c.linkId, groupId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Per-group visibility editor
// ============================================================

function GroupVisibilityEditor({
  group,
  onSaved,
}: {
  group: Circle;
  onSaved: (c: Circle) => void;
}) {
  const [vis, setVis] = useState<CardVisibility>(group.cardVisibility);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = (key: VisField, value: boolean) => {
    const next = { ...vis, [key]: value };
    setVis(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { data } = await api.patch(`/circles/${group.id}`, { cardVisibility: next });
        onSaved(data.data as Circle);
      } catch {
        /* keep optimistic state; next edit retries */
      }
    }, 600);
  };

  return (
    <div className="card-elevated" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-5)' }}>
      <div className="title-md" style={{ fontSize: '0.95rem', marginBottom: 'var(--spacing-1)' }}>
        Что видят люди из группы «{group.name}»
      </div>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7 }}>
        Имя, фамилия, телефон и роль видны всегда. Сохраняется автоматически.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {VIS_FIELDS.map((f) => {
          const on = vis[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => toggle(f.key, !on)}
              style={{
                padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)',
                border: 'none', cursor: 'pointer', fontWeight: 600,
                color: on ? '#fff' : 'var(--on-surface-variant)',
                background: on ? (group.color || 'var(--secondary)') : 'var(--surface-container)',
                opacity: on ? 1 : 0.6, transition: 'all 0.15s ease',
              }}
            >
              {f.label}: {on ? 'вид.' : 'скр.'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Invitation card
// ============================================================

function InvitationCard({
  inv, direction, myRole, theirRole, theirName, theirPhone, registered = true,
  onAccept, onReject, onCancel,
}: {
  inv: IncomingInvitation | OutgoingInvitation; direction: 'incoming' | 'outgoing';
  myRole: string | null; theirRole: string | null;
  theirName: string; theirPhone: string; registered?: boolean;
  onAccept?: () => void; onReject?: () => void; onCancel?: () => void;
}) {
  const isIncoming = direction === 'incoming';
  return (
    <div className={isIncoming ? 'wash-secondary' : 'wash-primary'} style={{ padding: 'var(--spacing-4)', borderRadius: 'var(--radius-sketch)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)' }}>
        <Avatar name={theirName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{theirName}</div>
          <div className="label-sm">{theirPhone}{!registered && ' — не зарегистрирован'}</div>
        </div>
        <span className="label-sm" style={{ color: isIncoming ? 'var(--secondary)' : 'var(--primary)', fontWeight: 600 }}>
          {isIncoming ? 'Входящее' : 'Исходящее'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        {myRole && <span className="label-sm">Я: <strong style={{ color: 'var(--secondary)' }}>{myRole}</strong></span>}
        {theirRole && <span className="label-sm">{theirName}: <strong style={{ color: 'var(--secondary)' }}>{theirRole}</strong></span>}
      </div>
      {inv.message && <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', fontStyle: 'italic' }}>&ldquo;{inv.message}&rdquo;</p>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label-sm">Истекает: {new Date(inv.expiresAt).toLocaleDateString('ru-RU')}</span>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
          {isIncoming && onAccept && <button onClick={onAccept} className="btn-primary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.8rem' }}>Принять</button>}
          {isIncoming && onReject && <button onClick={onReject} className="btn-secondary" style={{ padding: '0.3rem 0.9rem', fontSize: '0.8rem' }}>Отклонить</button>}
          {!isIncoming && onCancel && (
            <button onClick={onCancel} style={{ background: 'none', border: 'none', fontSize: '0.8rem', color: 'var(--danger)', cursor: 'pointer', fontWeight: 500 }}>
              Отменить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RolePicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [showCustom, setShowCustom] = useState(false);
  const isCustom = showCustom || (value !== '' && !ROLE_PRESETS.includes(value));

  return (
    <div className="card" style={{ padding: 'var(--spacing-4)' }}>
      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-3)' }}>{label}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {ROLE_PRESETS.map((preset) => (
          <button key={preset} type="button"
            onClick={() => { onChange(preset); setShowCustom(false); }}
            style={{
              padding: '0.3rem 0.7rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
              border: 'none', cursor: 'pointer', fontWeight: 500,
              background: value === preset ? 'var(--secondary-container)' : 'var(--surface-container-low)',
              color: value === preset ? 'var(--secondary)' : 'var(--on-surface-variant)',
              transition: 'background 0.15s',
            }}
          >
            {preset}
          </button>
        ))}
        <button type="button"
          onClick={() => { setShowCustom(true); onChange(''); }}
          style={{
            padding: '0.3rem 0.7rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
            border: '1.5px dashed var(--outline-variant)', background: isCustom ? 'var(--tertiary-container)' : 'transparent',
            cursor: 'pointer', fontWeight: 500,
            color: isCustom ? 'var(--tertiary)' : 'var(--on-surface-variant)',
          }}
        >
          Свой вариант
        </button>
      </div>
      {isCustom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Введите свой вариант..."
          className="input-sketch"
          autoFocus
          style={{ marginTop: 'var(--spacing-3)', fontSize: '0.85rem' }}
        />
      )}
    </div>
  );
}

// ============================================================
// Shared UI
// ============================================================

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const px = size === 'sm' ? '1.6rem' : '2.2rem';
  const fs = size === 'sm' ? '0.7rem' : '0.9rem';
  return (
    <div style={{
      width: px, height: px, borderRadius: 'var(--radius-sketch)',
      background: 'var(--secondary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: fs, color: 'var(--secondary)', flexShrink: 0,
    }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function pluralize(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (lastDigit > 1 && lastDigit < 5) return few;
  if (lastDigit === 1) return one;
  return many;
}
