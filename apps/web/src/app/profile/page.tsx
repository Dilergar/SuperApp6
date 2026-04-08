'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import { resolveCardVisibility } from '@superapp/shared';
import { PersonCard } from '../circles/PersonCard';

// ============================================================
// Types
// ============================================================

interface CardVisibility {
  dateOfBirth: boolean;
  age: boolean;
  onlineStatus: boolean;
  maritalStatus: boolean;
  city: boolean;
  bio: boolean;
  email: boolean;
  socialLinks: boolean;
}

interface Session {
  id: string;
  deviceInfo: string | null;
  lastActive: string;
  createdAt: string;
}

type Section = 'card' | 'stats' | 'roles' | 'subscription' | 'settings' | 'security';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'card', label: 'Моя карточка' },
  { key: 'stats', label: 'Статистика' },
  { key: 'roles', label: 'Мои роли' },
  { key: 'subscription', label: 'Подписка' },
  { key: 'settings', label: 'Настройки' },
  { key: 'security', label: 'Безопасность' },
];

const MARITAL_OPTIONS = [
  { value: '', label: 'Не указано' },
  { value: 'single', label: 'Не женат/не замужем' },
  { value: 'married', label: 'Женат/замужем' },
  { value: 'relationship', label: 'В отношениях' },
  { value: 'divorced', label: 'Разведён(а)' },
  { value: 'widowed', label: 'Вдовец/вдова' },
];

// ============================================================
// Main page
// ============================================================

export default function ProfilePage() {
  const router = useRouter();
  const { isReady, user: profile } = useRequireAuth();
  const logout = useAuthStore((s) => s.logout);
  const fetchProfile = useAuthStore((s) => s.fetchProfile);

  const [section, setSection] = useState<Section>('card');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Edit mode for card
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    firstName: '', lastName: '', bio: '', city: '', email: '',
    maritalStatus: '', telegram: '', instagram: '', linkedin: '', whatsapp: '',
    dateOfBirth: '',
  });

  useEffect(() => {
    if (profile) {
      setEditData({
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        bio: profile.bio || '',
        city: profile.city || '',
        email: profile.email || '',
        maritalStatus: profile.maritalStatus || '',
        telegram: profile.socialLinks?.telegram || '',
        instagram: profile.socialLinks?.instagram || '',
        linkedin: profile.socialLinks?.linkedin || '',
        whatsapp: profile.socialLinks?.whatsapp || '',
        dateOfBirth: profile.dateOfBirth || '',
      });
    }
  }, [profile]);

  const clear = () => { setError(''); setSuccessMsg(''); };

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  const handleSaveProfile = async () => {
    clear();
    if (!editData.firstName.trim()) {
      setError('Имя обязательно');
      return;
    }
    try {
      const payload: Record<string, unknown> = {};
      payload.firstName = editData.firstName.trim();
      payload.lastName = editData.lastName.trim() || null;
      payload.bio = editData.bio.trim() || null;
      payload.city = editData.city.trim() || null;
      payload.email = editData.email.trim() || null;
      payload.maritalStatus = editData.maritalStatus || null;
      payload.dateOfBirth = editData.dateOfBirth || null;
      const socialLinks: Record<string, string> = {};
      if (editData.telegram.trim()) socialLinks.telegram = editData.telegram.trim();
      if (editData.instagram.trim()) socialLinks.instagram = editData.instagram.trim();
      if (editData.linkedin.trim()) socialLinks.linkedin = editData.linkedin.trim();
      if (editData.whatsapp.trim()) socialLinks.whatsapp = editData.whatsapp.trim();
      payload.socialLinks = Object.keys(socialLinks).length > 0 ? socialLinks : null;

      await api.patch('/users/me', payload);
      await fetchProfile();
      setEditing(false);
      setSuccessMsg('Профиль обновлён');
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка сохранения');
    }
  };

  const handleToggleVisibility = async (field: keyof CardVisibility, value: boolean) => {
    clear();
    try {
      const current = profile?.cardVisibility || {};
      await api.patch('/users/me', { cardVisibility: { ...current, [field]: value } });
      await fetchProfile();
    } catch {
      setError('Ошибка обновления видимости');
    }
  };

  const fetchSessions = async () => {
    try {
      const { data } = await api.get('/users/me/sessions');
      setSessions(data.data);
    } catch {
      setError('Не удалось загрузить сессии');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    clear();
    try {
      await api.delete(`/users/me/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setSuccessMsg('Сессия завершена');
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка');
    }
  };

  useEffect(() => {
    if (section === 'security' && isReady) fetchSessions();
  }, [section, isReady]);

  if (!isReady || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  const p = profile;

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{ background: 'rgba(245, 245, 220, 0.7)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</Link>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
            <Link href="/circles" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Окружение</Link>
            <Link href="/dashboard" className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>Главная</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {/* Messages */}
        {error && <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
        {successMsg && <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{successMsg}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--spacing-8)', minHeight: '70vh' }}>
          {/* ============================================================ */}
          {/* Sidebar */}
          {/* ============================================================ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
            <h2 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Профиль</h2>
            {SECTIONS.map((s) => (
              <button key={s.key} onClick={() => { setSection(s.key); clear(); }}
                style={{
                  padding: 'var(--spacing-2) var(--spacing-3)', textAlign: 'left',
                  borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-body)', fontSize: '0.85rem', fontWeight: 500,
                  background: section === s.key ? 'var(--surface-container-lowest)' : 'transparent',
                  color: section === s.key ? 'var(--on-surface)' : 'var(--on-surface-variant)',
                  boxShadow: section === s.key ? '0 2px 8px rgba(56, 57, 45, 0.06)' : 'none',
                }}
              >
                {s.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={handleLogout}
              style={{
                padding: 'var(--spacing-2) var(--spacing-3)', textAlign: 'left',
                borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-body)', fontSize: '0.85rem', fontWeight: 500,
                background: 'transparent', color: 'var(--danger)',
                marginTop: 'var(--spacing-8)',
              }}
            >
              Выйти
            </button>
          </div>

          {/* ============================================================ */}
          {/* Content */}
          {/* ============================================================ */}
          <div>
            {/* === Card section === */}
            {section === 'card' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-6)' }}>
                  <h2 className="title-lg">Моя карточка</h2>
                  <button onClick={() => setEditing(!editing)} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
                    {editing ? 'Отмена' : 'Редактировать'}
                  </button>
                </div>

                {editing ? (
                  <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '500px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
                      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Имя *</label>
                          <input type="text" value={editData.firstName} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} className="input-sketch" />
                        </div>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Фамилия</label>
                          <input type="text" value={editData.lastName} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} className="input-sketch" />
                        </div>
                      </div>
                      <div>
                        <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>О себе (до 160 символов)</label>
                        <input type="text" value={editData.bio} onChange={(e) => setEditData({ ...editData, bio: e.target.value.slice(0, 160) })} className="input-sketch" placeholder="Расскажите о себе..." />
                        <span className="label-sm" style={{ fontSize: '0.65rem' }}>{editData.bio.length}/160</span>
                      </div>
                      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Город</label>
                          <input type="text" value={editData.city} onChange={(e) => setEditData({ ...editData, city: e.target.value })} className="input-sketch" placeholder="Алматы" />
                        </div>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Дата рождения</label>
                          <input type="date" value={editData.dateOfBirth} onChange={(e) => setEditData({ ...editData, dateOfBirth: e.target.value })} className="input-sketch" />
                        </div>
                      </div>
                      <div>
                        <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Email</label>
                        <input type="email" value={editData.email} onChange={(e) => setEditData({ ...editData, email: e.target.value })} className="input-sketch" placeholder="user@example.com" />
                      </div>
                      <div>
                        <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Семейное положение</label>
                        <select value={editData.maritalStatus} onChange={(e) => setEditData({ ...editData, maritalStatus: e.target.value })} className="input-sketch" style={{ cursor: 'pointer' }}>
                          {MARITAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Telegram</label>
                          <input type="text" value={editData.telegram} onChange={(e) => setEditData({ ...editData, telegram: e.target.value })} className="input-sketch" placeholder="@username" />
                        </div>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Instagram</label>
                          <input type="text" value={editData.instagram} onChange={(e) => setEditData({ ...editData, instagram: e.target.value })} className="input-sketch" placeholder="@username" />
                        </div>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>LinkedIn</label>
                          <input type="text" value={editData.linkedin} onChange={(e) => setEditData({ ...editData, linkedin: e.target.value })} className="input-sketch" placeholder="linkedin.com/in/..." />
                        </div>
                        <div>
                          <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>WhatsApp</label>
                          <input type="text" value={editData.whatsapp} onChange={(e) => setEditData({ ...editData, whatsapp: e.target.value })} className="input-sketch" placeholder="+77001234567" />
                        </div>
                      </div>
                      <button onClick={handleSaveProfile} className="btn-primary" style={{ marginTop: 'var(--spacing-2)' }}>Сохранить</button>
                    </div>
                  </div>
                ) : (
                  <PersonCard
                    mode="full"
                    profile={{
                      firstName: profile.firstName,
                      lastName: p.lastName,
                      phone: profile.phone,
                      avatar: p.avatar,
                      dateOfBirth: p.dateOfBirth,
                      bio: p.bio,
                      city: p.city,
                      email: p.email,
                      maritalStatus: p.maritalStatus,
                      socialLinks: p.socialLinks,
                      cardVisibility: resolveCardVisibility(p.cardVisibility ?? null),
                    }}
                    onToggleVisibility={handleToggleVisibility}
                  />
                )}
              </div>
            )}

            {/* === Stats section === */}
            {section === 'stats' && (
              <div>
                <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Статистика</h2>
                <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 'var(--spacing-4)' }}>
                  <StatTile label="Людей" value={p.contactsCount ?? 0} />
                  <StatTile label="Папок" value={p.circlesCount ?? 0} />
                  <StatTile label="Пространств" value={p.workspacesCount ?? 0} />
                  <StatTile label="Член с" value={new Date(profile.createdAt ?? '').toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' })} />
                </div>
              </div>
            )}

            {/* === Roles section === */}
            {section === 'roles' && (
              <div>
                <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Мои роли</h2>
                {p.roles && p.roles.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)' }}>
                    {p.roles.map((r, i) => (
                      <span key={i} className="sketch-role-badge">
                        {r.role}
                        <span style={{ opacity: 0.5, marginLeft: '0.3rem', fontSize: '0.7rem' }}>@ {r.context}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="label-md">Нет активных ролей</p>
                )}
              </div>
            )}

            {/* === Subscription section === */}
            {section === 'subscription' && (
              <div>
                <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Подписка</h2>
                {p.activeSubscription ? (
                  <div className="wash-secondary" style={{ padding: 'var(--spacing-6)', maxWidth: '400px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-3)' }}>
                      <span className="title-md" style={{ textTransform: 'capitalize' }}>{p.activeSubscription.plan}</span>
                      <span className="sketch-role-badge">{p.activeSubscription.status === 'trial' ? 'Пробный период' : p.activeSubscription.status}</span>
                    </div>
                    <p className="label-sm">Истекает: {new Date(p.activeSubscription.expiresAt).toLocaleDateString('ru-RU')}</p>
                  </div>
                ) : (
                  <div className="card" style={{ padding: 'var(--spacing-6)', maxWidth: '400px', textAlign: 'center' }}>
                    <p className="label-md" style={{ marginBottom: 'var(--spacing-4)' }}>Бесплатный план</p>
                    <button className="btn-primary" style={{ opacity: 0.5, cursor: 'not-allowed' }}>Улучшить (скоро)</button>
                  </div>
                )}
              </div>
            )}

            {/* === Settings section === */}
            {section === 'settings' && (
              <div>
                <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Настройки</h2>
                <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
                  <div>
                    <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Язык</label>
                    <select defaultValue={p.locale || 'ru'} className="input-sketch" disabled style={{ cursor: 'not-allowed', opacity: 0.6 }}>
                      <option value="ru">Русский</option>
                      <option value="kk">Қазақша</option>
                      <option value="en">English</option>
                    </select>
                    <span className="label-sm" style={{ fontSize: '0.65rem', opacity: 0.5 }}>Смена языка — скоро</span>
                  </div>
                  <div>
                    <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Часовой пояс</label>
                    <input type="text" defaultValue={p.timezone || 'Asia/Almaty'} className="input-sketch" disabled style={{ opacity: 0.6 }} />
                  </div>
                  <div>
                    <label className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-1)' }}>Онлайн-статус видят</label>
                    <select defaultValue={p.onlineStatusMode || 'everyone'} className="input-sketch" onChange={async (e) => {
                      try { await api.patch('/users/me', { onlineStatusMode: e.target.value }); await fetchProfile(); setSuccessMsg('Сохранено'); } catch { setError('Ошибка'); }
                    }} style={{ cursor: 'pointer' }}>
                      <option value="everyone">Все</option>
                      <option value="contacts">Только контакты</option>
                      <option value="nobody">Никто</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* === Security section === */}
            {section === 'security' && (
              <div>
                <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Безопасность</h2>

                <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Активные сессии</h3>
                {sessions.length === 0 ? (
                  <p className="label-md">Нет активных сессий</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', maxWidth: '500px' }}>
                    {sessions.map((s) => (
                      <div key={s.id} className="card" style={{ padding: 'var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{s.deviceInfo || 'Неизвестное устройство'}</div>
                          <div className="label-sm">Последняя активность: {new Date(s.lastActive).toLocaleString('ru-RU')}</div>
                        </div>
                        <button onClick={() => handleDeleteSession(s.id)}
                          style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}
                        >
                          Завершить
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 'var(--spacing-8)' }}>
                  <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Смена пароля</h3>
                  <button className="btn-secondary" style={{ opacity: 0.5, cursor: 'not-allowed', fontSize: '0.85rem' }}>
                    Изменить пароль (скоро)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Stat tile
// ============================================================

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-4)' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.8rem', fontWeight: 700, color: 'var(--primary)' }}>
        {value}
      </div>
      <div className="label-sm" style={{ marginTop: 'var(--spacing-1)' }}>{label}</div>
    </div>
  );
}
