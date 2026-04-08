'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { PersonCard } from './PersonCard';
import type {
  Contact,
  ContactUserCard,
  IncomingInvitation,
  OutgoingInvitation,
  Circle,
  CircleWithMembers,
} from '@superapp/shared';

// ============================================================
// Constants
// ============================================================

const ROLE_PRESETS = [
  'Жена', 'Муж', 'Мама', 'Папа', 'Сын', 'Дочь',
  'Семья', 'Родственник', 'Друг', 'Коллега',
  'Одноклассник', 'Однокурсник', 'Клиент',
];

const FOLDER_TEMPLATES = [
  { name: 'Семья', color: '#ffaca3' },
  { name: 'Друзья', color: '#c7e7ff' },
  { name: 'Коллеги', color: '#ffe08c' },
  { name: 'Одноклассники', color: '#c8e6c9' },
  { name: 'Университет', color: '#e1bee7' },
];

const FOLDER_COLORS = [
  '#ffaca3', '#c7e7ff', '#ffe08c', '#c8e6c9',
  '#e1bee7', '#ffccbc', '#b2dfdb', '#f0f4c3',
];



// ============================================================
// Main page
// ============================================================

export default function CirclesPage() {
  const { isReady } = useRequireAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [folders, setFolders] = useState<Circle[]>([]);
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

  // Folder create
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderColor, setFolderColor] = useState(FOLDER_COLORS[0]);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Folder filter — null = show all, string = filter by folder
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeFolderData, setActiveFolderData] = useState<CircleWithMembers | null>(null);

  // Invitations panel
  const [showInvitations, setShowInvitations] = useState(true);

  const clear = () => { setError(''); setSuccessMsg(''); };

  // ============================================================
  // Data fetching
  // ============================================================

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [c, inc, out, f] = await Promise.all([
        api.get('/contacts'),
        api.get('/contacts/invitations/incoming'),
        api.get('/contacts/invitations/outgoing'),
        api.get('/circles'),
      ]);
      setContacts(c.data.data);
      setIncoming(inc.data.data);
      setOutgoing(out.data.data);
      setFolders(f.data.data);
    } catch {
      setError('Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isReady) fetchAll();
  }, [isReady, fetchAll]);

  // When a folder is selected, load its members
  const selectFolder = async (folderId: string | null) => {
    if (folderId === null) {
      setActiveFolder(null);
      setActiveFolderData(null);
      return;
    }
    try {
      const { data } = await api.get(`/circles/${folderId}`);
      setActiveFolder(folderId);
      setActiveFolderData(data.data);
    } catch {
      setError('Не удалось загрузить папку');
    }
  };

  // ============================================================
  // Invitation actions
  // ============================================================

  // Lookup user by phone (debounced 500ms)
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

  // Cleanup lookup timer on unmount
  useEffect(() => {
    return () => { if (lookupTimer.current) clearTimeout(lookupTimer.current); };
  }, []);

  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    clear();
    setSending(true);
    try {
      // Auto-detect relationshipType from role presets
      const familyRoles = ['Жена', 'Муж', 'Мама', 'Папа', 'Сын', 'Дочь', 'Семья', 'Родственник'];
      const friendRoles = ['Друг'];
      const proRoles = ['Коллега', 'Клиент'];
      const eduRoles = ['Одноклассник', 'Однокурсник'];
      const allLabels = [invTheyForMe, invMeForThem];
      let relType = 'other';
      if (allLabels.some((l) => familyRoles.includes(l))) relType = 'family';
      else if (allLabels.some((l) => friendRoles.includes(l))) relType = 'friend';
      else if (allLabels.some((l) => proRoles.includes(l))) relType = 'professional';
      else if (allLabels.some((l) => eduRoles.includes(l))) relType = 'acquaintance';

      const payload: Record<string, unknown> = {
        toPhone: invPhone,
        relationshipType: relType,
      };
      if (invTheyForMe.trim()) payload.proposedLabelForRecipient = invTheyForMe.trim();
      if (invMeForThem.trim()) payload.proposedLabelForSender = invMeForThem.trim();
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
      if (activeFolder) selectFolder(activeFolder);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  // ============================================================
  // Folder actions
  // ============================================================

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folderName.trim()) return;
    clear();
    setCreatingFolder(true);
    try {
      await api.post('/circles', { name: folderName.trim(), color: folderColor });
      setFolderName('');
      setShowCreateFolder(false);
      setSuccessMsg('Папка создана');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    clear();
    try {
      await api.delete(`/circles/${folderId}`);
      if (activeFolder === folderId) { setActiveFolder(null); setActiveFolderData(null); }
      setSuccessMsg('Папка удалена');
      await fetchAll();
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleAddToFolder = async (contactLinkId: string, folderId: string) => {
    clear();
    try {
      await api.post(`/circles/${folderId}/members`, { contactLinkId });
      await fetchAll();
      if (activeFolder === folderId) selectFolder(folderId);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  const handleRemoveFromFolder = async (linkId: string) => {
    if (!activeFolder) return;
    clear();
    try {
      await api.delete(`/circles/${activeFolder}/members/${linkId}`);
      await fetchAll();
      selectFolder(activeFolder);
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
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
  const displayedContacts = activeFolder && activeFolderData
    ? activeFolderData.members
    : contacts;

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

        {/* ============================================================ */}
        {/* Header */}
        {/* ============================================================ */}
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

        {/* ============================================================ */}
        {/* Invite form */}
        {/* ============================================================ */}
        {showInvite && (
          <form onSubmit={handleSendInvitation} className="card-elevated" style={{ marginBottom: 'var(--spacing-8)', padding: 'var(--spacing-6)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Добавить в окружение</h3>

            {/* Phone input + lookup */}
            <div style={{ marginBottom: 'var(--spacing-4)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Номер телефона</label>
              <input type="tel" value={invPhone} onChange={(e) => handlePhoneLookup(e.target.value)} placeholder="+77001234567" className="input-sketch" autoFocus />
            </div>

            {/* Lookup result */}
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

            {/* Roles — two boxes with preset chips */}
            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
              <RolePicker
                label="Я"
                value={invMeForThem}
                onChange={setInvMeForThem}
              />
              <RolePicker
                label={invLookup ? invLookup.firstName : 'Он(а)'}
                value={invTheyForMe}
                onChange={setInvTheyForMe}
              />
            </div>

            {/* Message */}
            <div style={{ marginBottom: 'var(--spacing-6)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Сообщение</label>
              <input type="text" value={invMessage} onChange={(e) => setInvMessage(e.target.value)} placeholder="Привет! Давай добавимся..." className="input-sketch" />
            </div>

            <button type="submit" disabled={sending || invPhone.length < 12} className="btn-primary" style={{ fontSize: '0.9rem', opacity: (sending || invPhone.length < 12) ? 0.6 : 1 }}>
              {sending ? 'Отправка...' : 'Отправить приглашение'}
            </button>
          </form>
        )}

        {/* ============================================================ */}
        {/* Pending invitations — compact panel at the top */}
        {/* ============================================================ */}
        {(
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
                {/* Incoming */}
                {incoming.map((inv) => (
                  <InvitationCard key={inv.id} inv={inv} direction="incoming"
                    myLabel={inv.proposedLabelForRecipient} theirLabel={inv.proposedLabelForSender}
                    theirName={inv.from?.firstName || '?'}
                    theirPhone={inv.toPhone}
                    onAccept={() => handleAccept(inv.id)} onReject={() => handleReject(inv.id)} />
                ))}

                {/* Outgoing */}
                {outgoing.map((inv) => (
                  <InvitationCard key={inv.id} inv={inv} direction="outgoing"
                    myLabel={inv.proposedLabelForSender} theirLabel={inv.proposedLabelForRecipient}
                    theirName={inv.to?.firstName || inv.toPhone}
                    theirPhone={inv.toPhone}
                    registered={!!inv.to}
                    onCancel={() => handleCancel(inv.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* Folder chips — filter bar */}
        {/* ============================================================ */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
          {/* "All" chip */}
          <button
            onClick={() => selectFolder(null)}
            style={{
              padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
              border: 'none', cursor: 'pointer', fontWeight: 600,
              background: activeFolder === null ? 'var(--surface-container-lowest)' : 'var(--surface-container)',
              color: activeFolder === null ? 'var(--on-surface)' : 'var(--on-surface-variant)',
              boxShadow: activeFolder === null ? '0 2px 12px rgba(56, 57, 45, 0.08)' : 'none',
            }}
          >
            Все
          </button>

          {/* Folder chips */}
          {folders.map((f) => (
            <div key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
              <button
                onClick={() => selectFolder(f.id)}
                style={{
                  padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                  border: 'none', cursor: 'pointer', fontWeight: 500,
                  background: activeFolder === f.id ? (f.color || 'var(--secondary-container)') : 'var(--surface-container)',
                  color: activeFolder === f.id ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  opacity: activeFolder === f.id ? 1 : 0.8,
                }}
              >
                {f.name}
                <span style={{ marginLeft: '0.3rem', fontSize: '0.65rem', opacity: 0.6 }}>{f.membersCount}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Удалить папку "${f.name}"?`)) handleDeleteFolder(f.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: 'var(--outline)', opacity: 0.3, padding: '0 0.15rem' }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.3'; }}
                title="Удалить папку"
              >×</button>
            </div>
          ))}

          {/* New folder button */}
          <button
            onClick={() => setShowCreateFolder(!showCreateFolder)}
            style={{
              padding: '0.3rem 0.6rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sketch)',
              border: '1.5px dashed var(--outline-variant)', background: 'transparent',
              cursor: 'pointer', color: 'var(--on-surface-variant)', fontWeight: 500,
            }}
          >
            + папка
          </button>
        </div>

        {/* Create folder form */}
        {showCreateFolder && (
          <form onSubmit={handleCreateFolder} className="card" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '150px' }}>
                <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Название</label>
                <input type="text" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="Название..." className="input-sketch" autoFocus style={{ fontSize: '0.85rem' }} />
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
                {FOLDER_COLORS.slice(0, 6).map((color) => (
                  <button key={color} type="button" onClick={() => setFolderColor(color)}
                    style={{
                      width: '1.4rem', height: '1.4rem', borderRadius: '0.4rem',
                      background: color, border: folderColor === color ? '2px solid var(--primary)' : '1px solid transparent',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
              <button type="submit" disabled={creatingFolder || !folderName.trim()} className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.3rem 0.8rem' }}>
                Создать
              </button>
              <button type="button" onClick={() => setShowCreateFolder(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--on-surface-variant)' }}>
                Отмена
              </button>
            </div>
            {/* Quick templates */}
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              {FOLDER_TEMPLATES.map((t) => (
                <button key={t.name} type="button" onClick={() => { setFolderName(t.name); setFolderColor(t.color); }}
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

        {/* ============================================================ */}
        {/* People list */}
        {/* ============================================================ */}
        {displayedContacts.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}>
            <p className="label-md">
              {activeFolder ? 'В этой папке пока никого' : 'Пока никого в окружении'}
            </p>
            <p className="label-sm" style={{ marginTop: 'var(--spacing-2)' }}>
              {activeFolder ? 'Добавьте людей из окружения' : "Нажмите '+ Добавить' чтобы пригласить"}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--spacing-6)' }}>
            {displayedContacts.map((c) => (
              <PersonCard
                key={c.linkId}
                contact={c}
                folders={folders}
                activeFolder={activeFolder}
                onDelete={() => { if (confirm('Удалить из окружения? Это действие двустороннее.')) handleDeleteContact(c.linkId); }}
                onRemoveFromFolder={() => handleRemoveFromFolder(c.linkId)}
                onAddToFolder={(folderId) => handleAddToFolder(c.linkId, folderId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PersonCard — single person in the list
// ============================================================

function InvitationCard({
  inv, direction, myLabel, theirLabel, theirName, theirPhone, registered = true,
  onAccept, onReject, onCancel,
}: {
  inv: IncomingInvitation | OutgoingInvitation; direction: 'incoming' | 'outgoing';
  myLabel: string | null; theirLabel: string | null;
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
        {myLabel && <span className="label-sm">Я: <strong style={{ color: 'var(--secondary)' }}>{myLabel}</strong></span>}
        {theirLabel && <span className="label-sm">{theirName}: <strong style={{ color: 'var(--secondary)' }}>{theirLabel}</strong></span>}
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
