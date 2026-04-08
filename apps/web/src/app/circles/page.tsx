'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';

// ============================================================
// Types
// ============================================================

interface ContactUserCard {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  dateOfBirth: string | null;
}

interface Contact {
  linkId: string;
  relationshipType: string;
  them: ContactUserCard;
  myLabelForThem: string | null;
  theirLabelForMe: string | null;
  confirmedAt: string;
  myCircleIds: string[];
}

interface Folder {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  membersCount: number;
}

interface FolderDetail extends Folder {
  members: Contact[];
}

interface Invitation {
  id: string;
  fromUserId: string;
  toUserId: string | null;
  toPhone: string;
  proposedLabelForSender: string | null;
  proposedLabelForRecipient: string | null;
  relationshipType: string;
  message: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
  from?: ContactUserCard;
  to?: ContactUserCard | null;
}

// ============================================================
// Constants
// ============================================================

const RELATIONSHIP_OPTIONS = [
  { value: 'family', label: 'Семья' },
  { value: 'romantic', label: 'Партнёр' },
  { value: 'friend', label: 'Друг' },
  { value: 'professional', label: 'Коллега' },
  { value: 'acquaintance', label: 'Знакомый' },
  { value: 'other', label: 'Другое' },
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

function relLabel(value: string) {
  return RELATIONSHIP_OPTIONS.find((r) => r.value === value)?.label || value;
}

// ============================================================
// Main page
// ============================================================

export default function CirclesPage() {
  const { isReady } = useRequireAuth();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [incoming, setIncoming] = useState<Invitation[]>([]);
  const [outgoing, setOutgoing] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [invPhone, setInvPhone] = useState('+7');
  const [invRelType, setInvRelType] = useState('friend');
  const [invLabelForThem, setInvLabelForThem] = useState('');
  const [invLabelForMe, setInvLabelForMe] = useState('');
  const [invMessage, setInvMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Folder create
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderColor, setFolderColor] = useState(FOLDER_COLORS[0]);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Folder filter — null = show all, string = filter by folder
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeFolderData, setActiveFolderData] = useState<FolderDetail | null>(null);

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

  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    clear();
    setSending(true);
    try {
      const payload: Record<string, unknown> = {
        toPhone: invPhone,
        relationshipType: invRelType,
      };
      if (invLabelForThem.trim()) payload.proposedLabelForRecipient = invLabelForThem.trim();
      if (invLabelForMe.trim()) payload.proposedLabelForSender = invLabelForMe.trim();
      if (invMessage.trim()) payload.message = invMessage.trim();

      await api.post('/contacts/invitations', payload);
      setSuccessMsg('Приглашение отправлено!');
      setShowInvite(false);
      setInvPhone('+7');
      setInvRelType('friend');
      setInvLabelForThem('');
      setInvLabelForMe('');
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
          <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Главная</Link>
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

            <div style={{ marginBottom: 'var(--spacing-6)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Номер телефона *</label>
              <input type="tel" value={invPhone} onChange={(e) => setInvPhone(e.target.value)} placeholder="+77001234567" className="input-sketch" autoFocus />
            </div>

            <div style={{ marginBottom: 'var(--spacing-6)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Кем является для вас</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {RELATIONSHIP_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" onClick={() => setInvRelType(opt.value)}
                    style={{
                      padding: '0.3rem 0.8rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                      border: 'none', cursor: 'pointer', fontWeight: 500,
                      background: invRelType === opt.value ? 'var(--secondary-container)' : 'var(--surface-container)',
                      color: invRelType === opt.value ? 'var(--secondary)' : 'var(--on-surface-variant)',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-6)' }}>
              <div>
                <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Кем они вас назовут</label>
                <input type="text" value={invLabelForMe} onChange={(e) => setInvLabelForMe(e.target.value)} placeholder="муж, подруга, коллега..." className="input-sketch" />
              </div>
              <div>
                <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Как вы их назовёте</label>
                <input type="text" value={invLabelForThem} onChange={(e) => setInvLabelForThem(e.target.value)} placeholder="жена, друг..." className="input-sketch" />
              </div>
            </div>

            <div style={{ marginBottom: 'var(--spacing-6)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Сообщение</label>
              <input type="text" value={invMessage} onChange={(e) => setInvMessage(e.target.value)} placeholder="Привет! Давай добавимся..." className="input-sketch" />
            </div>

            <button type="submit" disabled={sending} className="btn-primary" style={{ fontSize: '0.9rem', opacity: sending ? 0.6 : 1 }}>
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
                  <div key={inv.id} className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                    <Avatar name={inv.from?.firstName || '?'} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                        {inv.from?.firstName} {inv.from?.lastName || ''}
                      </span>
                      <span className="label-sm" style={{ marginLeft: '0.4rem' }}>
                        хочет добавить вас
                      </span>
                      {inv.message && <span className="label-sm" style={{ marginLeft: '0.3rem', fontStyle: 'italic' }}> — &ldquo;{inv.message}&rdquo;</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexShrink: 0 }}>
                      <button onClick={() => handleAccept(inv.id)} className="btn-primary" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>Принять</button>
                      <button onClick={() => handleReject(inv.id)} className="btn-secondary" style={{ padding: '0.25rem 0.7rem', fontSize: '0.75rem' }}>Отклонить</button>
                    </div>
                  </div>
                ))}

                {/* Outgoing */}
                {outgoing.map((inv) => (
                  <div key={inv.id} className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', opacity: 0.85 }}>
                    <Avatar name={inv.to?.firstName || inv.toPhone.slice(-2)} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                        {inv.to ? `${inv.to.firstName} ${inv.to.lastName || ''}` : inv.toPhone}
                      </span>
                      <span className="label-sm" style={{ marginLeft: '0.4rem' }}>
                        — ждёт ответа
                      </span>
                    </div>
                    <button onClick={() => handleCancel(inv.id)} style={{
                      background: 'none', border: 'none', fontSize: '0.75rem', color: 'var(--danger)',
                      cursor: 'pointer', fontWeight: 500, flexShrink: 0,
                    }}>
                      Отменить
                    </button>
                  </div>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
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

function PersonCard({
  contact,
  folders,
  activeFolder,
  onDelete,
  onRemoveFromFolder,
  onAddToFolder,
}: {
  contact: Contact;
  folders: Folder[];
  activeFolder: string | null;
  onDelete: () => void;
  onRemoveFromFolder: () => void;
  onAddToFolder: (folderId: string) => void;
}) {
  const [showFolderMenu, setShowFolderMenu] = useState(false);

  // Folders this person is NOT in yet
  const foldersNotIn = folders.filter((f) => !contact.myCircleIds.includes(f.id));
  // Folders this person IS in
  const foldersIn = folders.filter((f) => contact.myCircleIds.includes(f.id));

  return (
    <div className="card-elevated" style={{ padding: 'var(--spacing-4) var(--spacing-6)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-4)' }}>
      <Avatar name={contact.them.firstName} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{contact.them.firstName} {contact.them.lastName || ''}</div>
        <div className="label-sm">{contact.them.phone}</div>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-1)', flexWrap: 'wrap', alignItems: 'center' }}>
          {contact.myLabelForThem && (
            <span className="ghost-border" style={{ padding: '0.1rem 0.5rem', fontSize: '0.7rem', color: 'var(--secondary)' }}>
              {contact.myLabelForThem}
            </span>
          )}
          <Tag>{relLabel(contact.relationshipType)}</Tag>
          {/* Folder tags */}
          {foldersIn.map((f) => (
            <span key={f.id} style={{
              fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: '0.3rem',
              background: f.color || 'var(--surface-container-high)', opacity: 0.7,
            }}>
              {f.name}
            </span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexShrink: 0 }}>
        {/* Add to folder / remove from folder */}
        {activeFolder ? (
          <button onClick={onRemoveFromFolder} title="Убрать из папки"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', color: 'var(--on-surface-variant)', opacity: 0.5 }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
          >
            убрать
          </button>
        ) : (
          <div style={{ position: 'relative' }}>
            {folders.length > 0 && (
              <button
                onClick={() => setShowFolderMenu(!showFolderMenu)}
                title="Добавить в папку"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: '0.85rem', color: 'var(--outline)', opacity: 0.4,
                  padding: '0.2rem',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e) => { if (!showFolderMenu) e.currentTarget.style.opacity = '0.4'; }}
              >
                +
              </button>
            )}
            {showFolderMenu && foldersNotIn.length > 0 && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', zIndex: 10,
                background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-md)',
                boxShadow: '0 8px 32px rgba(56, 57, 45, 0.12)', padding: 'var(--spacing-2)',
                minWidth: '120px',
              }}>
                {foldersNotIn.map((f) => (
                  <button key={f.id} onClick={() => { onAddToFolder(f.id); setShowFolderMenu(false); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)',
                      padding: '0.3rem 0.5rem', width: '100%', background: 'none', border: 'none',
                      cursor: 'pointer', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)',
                      color: 'var(--on-surface)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-container-low)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                  >
                    <span style={{ width: '0.6rem', height: '0.6rem', borderRadius: '0.2rem', background: f.color || 'var(--surface-container-high)' }} />
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={onDelete}
          style={{ background: 'none', border: 'none', color: 'var(--outline)', cursor: 'pointer', fontSize: '1.1rem', padding: '0.3rem', opacity: 0.3 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.3'; }}
          title="Удалить"
        >×</button>
      </div>
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

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)', background: 'var(--surface-container)', padding: '0.1rem 0.5rem', borderRadius: 'var(--radius-sm)' }}>
      {children}
    </span>
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
