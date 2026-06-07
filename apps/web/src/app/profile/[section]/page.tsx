'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import { resolveCardVisibility, type CardVisibility, type Circle } from '@superapp/shared';
import { PersonCard } from '../../circles/PersonCard';
import { WalletSection } from '../WalletSection';
import { SkinsSection } from '../SkinsSection';
import type { CardSkinRender } from '../../circles/card-skin';

// ============================================================
// Types & constants
// ============================================================

interface Session {
  id: string;
  deviceInfo: string | null;
  lastActive: string;
  createdAt: string;
}

type Section = 'form' | 'card' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'security';

const KNOWN_SECTIONS: Section[] = ['form', 'card', 'skins', 'wallet', 'stats', 'roles', 'subscription', 'settings', 'security'];

const MARITAL_OPTIONS = [
  { value: '', label: 'Не указано' },
  { value: 'single', label: 'Не женат/не замужем' },
  { value: 'married', label: 'Женат/замужем' },
  { value: 'relationship', label: 'В отношениях' },
  { value: 'divorced', label: 'Разведён(а)' },
  { value: 'widowed', label: 'Вдовец/вдова' },
];

type VisField =
  | 'city' | 'bio' | 'dateOfBirth' | 'age'
  | 'maritalStatus' | 'email' | 'socialLinks' | 'onlineStatus';

const FIELD_META: { key: VisField; label: string }[] = [
  { key: 'city', label: 'Город' },
  { key: 'bio', label: 'О себе' },
  { key: 'dateOfBirth', label: 'Дата рождения' },
  { key: 'age', label: 'Возраст' },
  { key: 'maritalStatus', label: 'Семейное положение' },
  { key: 'email', label: 'Email' },
  { key: 'socialLinks', label: 'Соцсети' },
  { key: 'onlineStatus', label: 'Онлайн-статус' },
];

const DEFAULT_PREVIEW = '__default__';

// ============================================================
// Section content (chrome — nav + sidebar — lives in layout.tsx)
// ============================================================

export default function ProfileSectionPage() {
  const router = useRouter();
  const params = useParams<{ section: string }>();
  const rawSection = (params?.section ?? 'card') as Section;
  const section: Section = KNOWN_SECTIONS.includes(rawSection) ? rawSection : 'card';

  const { isReady, user: profile } = useRequireAuth();
  const logout = useAuthStore((s) => s.logout);
  const fetchProfile = useAuthStore((s) => s.fetchProfile);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Circle[]>([]);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [editData, setEditData] = useState({
    firstName: '', lastName: '', bio: '', city: '', email: '',
    maritalStatus: '', telegram: '', instagram: '', linkedin: '', whatsapp: '',
    dateOfBirth: '',
  });

  // Owner DEFAULT visibility (for contacts in no group). Seeded once.
  const [vis, setVis] = useState<CardVisibility | null>(null);
  const visSeeded = useRef(false);
  const visTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "Моя карточка" — preview as a group (or default).
  const [previewId, setPreviewId] = useState<string>(DEFAULT_PREVIEW);

  // My equipped default skin — for the «Моя карточка» preview.
  const [mySkin, setMySkin] = useState<CardSkinRender | null>(null);

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

  // Seed default visibility once (later refetch must not clobber edits).
  useEffect(() => {
    if (profile && !visSeeded.current) {
      setVis(resolveCardVisibility(profile.cardVisibility ?? null));
      visSeeded.current = true;
    }
  }, [profile]);

  // Groups — for the per-group preview selector.
  useEffect(() => {
    if (!isReady) return;
    api.get('/circles').then((r) => setGroups(r.data.data)).catch(() => {});
  }, [isReady]);

  // My equipped default skin — resolve(self) returns my default (no self-group overrides).
  useEffect(() => {
    const id = (profile as { id?: string } | null)?.id;
    if (!isReady || !id) return;
    api.get('/card-skins/resolve', { params: { userIds: id } })
      .then((r) => setMySkin(r.data.data[id] ?? null))
      .catch(() => {});
  }, [isReady, profile]);

  // Clean up the debounced visibility-save timer on unmount.
  useEffect(() => () => { if (visTimer.current) clearTimeout(visTimer.current); }, []);

  const clear = () => { setError(''); setSuccessMsg(''); };

  const handleDeleteAccount = async () => {
    setDeleteError('');
    if (!deletePassword) { setDeleteError('Введите пароль'); return; }
    setDeleting(true);
    try {
      // Schedules deletion (30-day grace) and revokes sessions server-side.
      await api.delete('/users/me', { data: { password: deletePassword } });
      await logout(); // clear local state + redirect with a recovery hint
      router.push('/login?deleted=1');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setDeleteError(axiosErr.response?.data?.message || 'Не удалось удалить аккаунт');
      setDeleting(false);
    }
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
      setSuccessMsg('Анкета сохранена');
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Ошибка сохранения');
    }
  };

  // Toggle one field in the DEFAULT visibility, debounce-persist.
  const toggleVis = (field: VisField, value: boolean) => {
    if (!vis) return;
    clear();
    const next: CardVisibility = { ...vis, [field]: value };
    setVis(next);
    if (visTimer.current) clearTimeout(visTimer.current);
    visTimer.current = setTimeout(async () => {
      try {
        await api.patch('/users/me', { cardVisibility: next });
        setSuccessMsg('Видимость по умолчанию сохранена');
      } catch {
        setError('Ошибка сохранения видимости');
      }
    }, 600);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, isReady]);

  if (!isReady || !profile) {
    return <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>;
  }

  const p = profile;
  const previewGroup = groups.find((g) => g.id === previewId) ?? null;
  const previewVis = previewGroup
    ? resolveCardVisibility(previewGroup.cardVisibility)
    : resolveCardVisibility(vis ?? p.cardVisibility ?? null);
  const previewLabel = previewGroup ? previewGroup.name : 'По умолчанию (без группы)';

  return (
    <div>
      {/* Messages */}
      {error && <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
      {successMsg && <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{successMsg}</div>}

      {/* === Моя Анкета: данные + видимость по умолчанию === */}
      {section === 'form' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Моя Анкета</h2>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
            Здесь вся информация. Видимость для конкретных людей настраивается по Группам на странице «Окружение».
          </p>

          <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '560px' }}>
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
              <button onClick={handleSaveProfile} className="btn-primary" style={{ marginTop: 'var(--spacing-2)' }}>Сохранить анкету</button>
            </div>
          </div>

          {/* Default visibility (for people in no group) */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>Видимость по умолчанию</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            Что видит человек из окружения, которого ты ещё не добавил ни в одну Группу.
            Имя, фамилия, телефон и роль видны всегда. Сохраняется автоматически.
          </p>
          {vis && (
            <div className="card-elevated" style={{ padding: 'var(--spacing-4)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {FIELD_META.map((f) => {
                  const on = vis[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => toggleVis(f.key, !on)}
                      style={{
                        padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)',
                        border: 'none', cursor: 'pointer', fontWeight: 600,
                        color: on ? '#fff' : 'var(--on-surface-variant)',
                        background: on ? 'var(--secondary)' : 'var(--surface-container)',
                        opacity: on ? 1 : 0.6, transition: 'all 0.15s ease',
                      }}
                    >
                      {f.label}: {on ? 'вид.' : 'скр.'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* === Моя карточка: просмотр + «как видит Группа X» === */}
      {section === 'card' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
            <h2 className="title-lg">Моя карточка</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <span className="label-sm">Как видит:</span>
              <select
                value={previewId}
                onChange={(e) => setPreviewId(e.target.value)}
                className="input-sketch"
                style={{ cursor: 'pointer', padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
              >
                <option value={DEFAULT_PREVIEW}>По умолчанию (без группы)</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            Так выглядит ваша карточка для «{previewLabel}». Данные меняются во вкладке «Моя Анкета»,
            видимость групп — на странице «Окружение».
          </p>
          <PersonCard
            mode="full"
            skin={mySkin ?? undefined}
            profile={{
              firstName: p.firstName,
              lastName: p.lastName ?? null,
              phone: p.phone,
              avatar: p.avatar ?? null,
              dateOfBirth: p.dateOfBirth ?? null,
              bio: p.bio ?? null,
              city: p.city ?? null,
              email: p.email ?? null,
              maritalStatus: p.maritalStatus ?? null,
              socialLinks: p.socialLinks ?? null,
              cardVisibility: previewVis,
            }}
          />
        </div>
      )}

      {/* === Скины карточки === */}
      {section === 'skins' && <SkinsSection profile={profile as never} />}

      {/* === Кошелёк === */}
      {section === 'wallet' && <WalletSection />}

      {/* === Stats === */}
      {section === 'stats' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Статистика</h2>
          <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 'var(--spacing-4)' }}>
            <StatTile label="Людей" value={p.contactsCount ?? 0} />
            <StatTile label="Групп" value={p.circlesCount ?? 0} />
            <StatTile label="Пространств" value={p.workspacesCount ?? 0} />
            <StatTile label="Член с" value={p.createdAt ? new Date(p.createdAt).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }) : '—'} />
          </div>
        </div>
      )}

      {/* === Roles === */}
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

      {/* === Subscription === */}
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

      {/* === Settings === */}
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

      {/* === Security === */}
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

          <div style={{ marginTop: 'var(--spacing-8)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>Опасная зона</h3>
            <button
              onClick={() => { setShowDeleteModal(true); setDeletePassword(''); setDeleteError(''); }}
              style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: '1.5px solid var(--danger)', borderRadius: '10px', padding: 'var(--spacing-2) var(--spacing-4)', cursor: 'pointer' }}
            >
              Удалить аккаунт
            </button>
          </div>
        </div>
      )}

      {/* Delete-account confirmation */}
      {showDeleteModal && (
        <div onClick={() => !deleting && setShowDeleteModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(40,40,30,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 'var(--spacing-4)' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: '440px', width: '100%', padding: 'var(--spacing-6)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>Удалить аккаунт?</h3>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.55 }}>
              Аккаунт будет помечен на удаление. У вас есть <b>30 дней</b>, чтобы передумать — просто войдите снова, и он восстановится. По истечении срока данные удаляются безвозвратно.
            </p>
            <input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} placeholder="Подтвердите текущим паролем" className="input-sketch" style={{ marginBottom: 'var(--spacing-3)' }} />
            {deleteError && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 'var(--spacing-3)' }}>{deleteError}</p>}
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" disabled={deleting} style={{ fontSize: '0.85rem' }} onClick={() => { setShowDeleteModal(false); setDeletePassword(''); setDeleteError(''); }}>Отмена</button>
              <button disabled={deleting} onClick={handleDeleteAccount} style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff', background: 'var(--danger)', border: 'none', borderRadius: '10px', padding: 'var(--spacing-2) var(--spacing-5)', cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1 }}>{deleting ? 'Удаление…' : 'Удалить'}</button>
            </div>
          </div>
        </div>
      )}
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
