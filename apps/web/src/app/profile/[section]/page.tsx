'use client';

import { Button, Input, ModalShell, Select } from '@/components/ui';
import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { api } from '@/lib/api';
import {
  MONTH_NAMES_RU,
  REQUISITE_VISIBILITY_EXTRAS,
  REQUISITE_VISIBILITY_LABELS,
  isValidIinOrBin,
  resolveCardVisibility,
  type CardVisibility,
  type Circle,
} from '@superapp/shared';
import { PersonCard } from '../../circles/PersonCard';
import { WalletSection } from '../WalletSection';
import { SkinsSection } from '../SkinsSection';
import { AvatarUploadBlock } from '@/components/files/AvatarUploadBlock';
import { ChangePasswordDialog, ChangePhoneDialog } from './security-dialogs';
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
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [showPhoneDialog, setShowPhoneDialog] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [editData, setEditData] = useState({
    firstName: '', lastName: '', bio: '', city: '', email: '',
    maritalStatus: '', telegram: '', instagram: '', linkedin: '', whatsapp: '',
    // Дата рождения — ТРИ поля (день / месяц названием / год), решение продукта.
    dobDay: '', dobMonth: '', dobYear: '',
    // Реквизиты «Для договоров и трудоустройства».
    iin: '', residentialAddress: '', idDocNumber: '', idDocIssuedBy: '', idDocIssuedAt: '',
  });

  // Owner DEFAULT visibility (for contacts in no group). Seeded once.
  const [vis, setVis] = useState<CardVisibility | null>(null);
  const visSeeded = useRef(false);
  const visTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // «Видимость в Компаниях» — что видят коллеги по организациям (ростер «Сотрудники»).
  const [visCompany, setVisCompany] = useState<CardVisibility | null>(null);
  const visCompanyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "Моя карточка" — preview as a group (or default).
  const [previewId, setPreviewId] = useState<string>(DEFAULT_PREVIEW);

  // My equipped default skin — for the «Моя карточка» preview.
  const [mySkin, setMySkin] = useState<CardSkinRender | null>(null);

  useEffect(() => {
    if (profile) {
      const dob = profile.dateOfBirth ? profile.dateOfBirth.split('-') : null; // YYYY-MM-DD
      const req = profile as unknown as {
        iin?: string | null;
        residentialAddress?: string | null;
        idDocNumber?: string | null;
        idDocIssuedBy?: string | null;
        idDocIssuedAt?: string | null;
      };
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
        dobDay: dob ? String(Number(dob[2])) : '',
        dobMonth: dob ? String(Number(dob[1]) - 1) : '',
        dobYear: dob ? dob[0] : '',
        iin: req.iin || '',
        residentialAddress: req.residentialAddress || '',
        idDocNumber: req.idDocNumber || '',
        idDocIssuedBy: req.idDocIssuedBy || '',
        idDocIssuedAt: req.idDocIssuedAt || '',
      });
    }
  }, [profile]);

  // Seed default visibility once (later refetch must not clobber edits).
  useEffect(() => {
    if (profile && !visSeeded.current) {
      setVis(resolveCardVisibility(profile.cardVisibility ?? null));
      setVisCompany(
        resolveCardVisibility(
          (profile as { companyCardVisibility?: CardVisibility | null }).companyCardVisibility ?? null,
        ),
      );
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

  // Clean up the debounced visibility-save timers on unmount.
  useEffect(() => () => {
    if (visTimer.current) clearTimeout(visTimer.current);
    if (visCompanyTimer.current) clearTimeout(visCompanyTimer.current);
  }, []);

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
    // Дата рождения собирается из трёх полей; заполнена частично — честная ошибка,
    // а не молча сохранённая пустота.
    const dobParts = [editData.dobDay, editData.dobMonth, editData.dobYear];
    const dobFilled = dobParts.filter((p) => p !== '').length;
    if (dobFilled > 0 && dobFilled < 3) {
      setError('Дата рождения: заполните день, месяц и год (или очистите все три поля)');
      return;
    }
    let dateOfBirth: string | null = null;
    if (dobFilled === 3) {
      const day = Number(editData.dobDay);
      const monthIdx = Number(editData.dobMonth);
      const year = Number(editData.dobYear);
      const composed = new Date(Date.UTC(year, monthIdx, day));
      if (
        composed.getUTCFullYear() !== year ||
        composed.getUTCMonth() !== monthIdx ||
        composed.getUTCDate() !== day ||
        year < 1900 ||
        composed.getTime() > Date.now()
      ) {
        setError('Дата рождения: такой даты не существует');
        return;
      }
      dateOfBirth = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (editData.iin.trim() && !isValidIinOrBin(editData.iin.trim())) {
      setError('ИИН: 12 цифр, проверьте номер — не сходится контрольная сумма');
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
      payload.dateOfBirth = dateOfBirth;
      payload.iin = editData.iin.trim() || null;
      payload.residentialAddress = editData.residentialAddress.trim() || null;
      payload.idDocNumber = editData.idDocNumber.trim() || null;
      payload.idDocIssuedBy = editData.idDocIssuedBy.trim() || null;
      payload.idDocIssuedAt = editData.idDocIssuedAt || null;
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

  // Toggle one field in the COMPANY visibility (что видят коллеги), debounce-persist.
  const toggleVisCompany = (field: VisField, value: boolean) => {
    if (!visCompany) return;
    clear();
    const next: CardVisibility = { ...visCompany, [field]: value };
    setVisCompany(next);
    if (visCompanyTimer.current) clearTimeout(visCompanyTimer.current);
    visCompanyTimer.current = setTimeout(async () => {
      try {
        await api.patch('/users/me', { companyCardVisibility: next });
        setSuccessMsg('Видимость в Компаниях сохранена');
      } catch {
        setError('Ошибка сохранения видимости');
      }
    }, 600);
  };

  // Реквизитные тумблеры коллегам живут в мешке extras той же карты (по умолчанию
  // выключены). На управляющих (manager+) они не действуют — тем блок виден всегда.
  const toggleVisCompanyExtra = (key: string, value: boolean) => {
    if (!visCompany) return;
    clear();
    const next: CardVisibility = {
      ...visCompany,
      extras: { ...(visCompany.extras ?? {}), [key]: value },
    };
    setVisCompany(next);
    if (visCompanyTimer.current) clearTimeout(visCompanyTimer.current);
    visCompanyTimer.current = setTimeout(async () => {
      try {
        await api.patch('/users/me', { companyCardVisibility: next });
        setSuccessMsg('Видимость в Компаниях сохранена');
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
      {error && <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
      {successMsg && <div className="alert-accent-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{successMsg}</div>}

      {/* === Моя Анкета: данные + видимость по умолчанию === */}
      {section === 'form' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>Моя Анкета</h2>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
            Здесь вся информация. Видимость для конкретных людей настраивается по Группам на странице «Окружение».
          </p>

          <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '560px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
              {/* Аватарка через движок файлов (профиль 'avatar', публичная вечная ссылка).
                  Сохраняется сразу, не через кнопку «Сохранить анкету». */}
              <AvatarUploadBlock
                current={profile?.avatar ?? null}
                fallback={(profile?.firstName?.[0] ?? '?').toUpperCase()}
                label="Аватарка"
                onSaved={async (url) => {
                  await api.patch('/users/me', { avatar: url });
                  await fetchProfile();
                  setSuccessMsg(url ? 'Фото обновлено' : 'Фото удалено');
                  setTimeout(() => setSuccessMsg(''), 2500);
                }}
              />
              {/* Поля — из кита: он сам связывает подпись с полем (htmlFor+id).
                  Раньше подписи стояли отдельными <label> без связи, и ни одно поле
                  анкеты не имело имени для скринридера, а клик по подписи не наводил
                  курсор в поле. */}
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input label="Имя" required value={editData.firstName} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} />
                <Input label="Фамилия" value={editData.lastName} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} />
              </div>
              <Input
                label="О себе"
                hint={`${editData.bio.length}/160 символов`}
                value={editData.bio}
                onChange={(e) => setEditData({ ...editData, bio: e.target.value.slice(0, 160) })}
                placeholder="Расскажите о себе..."
              />
              <Input label="Город" value={editData.city} onChange={(e) => setEditData({ ...editData, city: e.target.value })} placeholder="Алматы" />
              {/* Дата рождения — три поля (день / месяц названием / год), решение продукта */}
              <div>
                <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>Дата рождения</span>
                <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: 'var(--spacing-3)' }}>
                  <Input
                    aria-label="День рождения"
                    inputMode="numeric"
                    placeholder="День"
                    value={editData.dobDay}
                    onChange={(e) => setEditData({ ...editData, dobDay: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                  />
                  <Select
                    aria-label="Месяц рождения"
                    value={editData.dobMonth}
                    onChange={(v) => setEditData({ ...editData, dobMonth: v })}
                    options={[
                      { value: '', label: 'Месяц' },
                      ...MONTH_NAMES_RU.map((m, i) => ({ value: String(i), label: m })),
                    ]}
                  />
                  <Input
                    aria-label="Год рождения"
                    inputMode="numeric"
                    placeholder="Год"
                    value={editData.dobYear}
                    onChange={(e) => setEditData({ ...editData, dobYear: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  />
                </div>
              </div>
              <Input label="Email" type="email" value={editData.email} onChange={(e) => setEditData({ ...editData, email: e.target.value })} placeholder="user@example.com" />
              <Select
                label="Семейное положение"
                value={editData.maritalStatus}
                onChange={(v) => setEditData({ ...editData, maritalStatus: v })}
                options={MARITAL_OPTIONS}
              />
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input label="Telegram" value={editData.telegram} onChange={(e) => setEditData({ ...editData, telegram: e.target.value })} placeholder="@username" />
                <Input label="Instagram" value={editData.instagram} onChange={(e) => setEditData({ ...editData, instagram: e.target.value })} placeholder="@username" />
                <Input label="LinkedIn" value={editData.linkedin} onChange={(e) => setEditData({ ...editData, linkedin: e.target.value })} placeholder="linkedin.com/in/..." />
                <Input label="WhatsApp" value={editData.whatsapp} onChange={(e) => setEditData({ ...editData, whatsapp: e.target.value })} placeholder="+77001234567" />
              </div>
              {/* ---- Реквизиты: комплект для трудового договора и выплат ---- */}
              <h3 className="title-md" style={{ margin: 'var(--spacing-4) 0 0' }}>Для договоров и трудоустройства</h3>
              <p className="label-sm" style={{ margin: 0, opacity: 0.7, lineHeight: 1.5 }}>
                Эти данные видят только управляющие организаций, где вы работаете, — для договоров,
                трудоустройства и выплат. Друзьям и коллегам они не показываются (коллегам — только
                если включите ниже в «Видимости в Компаниях»).
              </p>
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input
                  label="ИИН"
                  inputMode="numeric"
                  placeholder="12 цифр"
                  value={editData.iin}
                  onChange={(e) => setEditData({ ...editData, iin: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                  error={editData.iin && !isValidIinOrBin(editData.iin) ? 'Не сходится контрольная сумма' : undefined}
                />
                <Input
                  label="Адрес проживания"
                  value={editData.residentialAddress}
                  onChange={(e) => setEditData({ ...editData, residentialAddress: e.target.value })}
                  placeholder="г. Алматы, ул. …, д. …, кв. …"
                />
              </div>
              <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-4)' }}>
                <Input
                  label="Удостоверение №"
                  value={editData.idDocNumber}
                  onChange={(e) => setEditData({ ...editData, idDocNumber: e.target.value })}
                  placeholder="0XXXXXXXX"
                />
                <Input
                  label="Кем выдано"
                  value={editData.idDocIssuedBy}
                  onChange={(e) => setEditData({ ...editData, idDocIssuedBy: e.target.value })}
                  placeholder="МВД РК"
                />
                <Input
                  label="Дата выдачи"
                  type="date"
                  value={editData.idDocIssuedAt}
                  onChange={(e) => setEditData({ ...editData, idDocIssuedAt: e.target.value })}
                />
              </div>
              <p className="label-sm" style={{ margin: 0, opacity: 0.7 }}>
                Карта для выплат добавляется в разделе «Кошелёк».
              </p>
              <Button variant="primary" tone="success" onClick={handleSaveProfile} style={{ marginTop: 'var(--spacing-2)', alignSelf: 'flex-start' }}>
                Сохранить анкету
              </Button>
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
                        color: on ? 'var(--on-primary)' : 'var(--on-surface-variant)',
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

          {/* Видимость в Компаниях (что видят коллеги по организациям) */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>Видимость в Компаниях</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            Что видят коллеги по организациям на твоей карточке в разделе «Сотрудники».
            Имя, фамилия, телефон и должность видны всегда. Сохраняется автоматически.
          </p>
          {visCompany && (
            <div className="card-elevated" style={{ padding: 'var(--spacing-4)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {FIELD_META.map((f) => {
                  const on = visCompany[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => toggleVisCompany(f.key, !on)}
                      style={{
                        padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)',
                        border: 'none', cursor: 'pointer', fontWeight: 600,
                        color: on ? 'var(--on-primary)' : 'var(--on-surface-variant)',
                        background: on ? 'var(--secondary)' : 'var(--surface-container)',
                        opacity: on ? 1 : 0.6, transition: 'all 0.15s ease',
                      }}
                    >
                      {f.label}: {on ? 'вид.' : 'скр.'}
                    </button>
                  );
                })}
              </div>
              {/* Конфиденциальные реквизиты коллегам — по умолчанию ВЫКЛЮЧЕНЫ */}
              <p className="label-sm" style={{ margin: 'var(--spacing-4) 0 var(--spacing-2)', opacity: 0.7 }}>
                Конфиденциальное (коллегам по умолчанию скрыто):
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {(Object.values(REQUISITE_VISIBILITY_EXTRAS) as string[]).map((key) => {
                  const on = !!visCompany.extras?.[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleVisCompanyExtra(key, !on)}
                      style={{
                        padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)',
                        border: 'none', cursor: 'pointer', fontWeight: 600,
                        color: on ? 'var(--on-primary)' : 'var(--on-surface-variant)',
                        background: on ? 'var(--secondary)' : 'var(--surface-container)',
                        opacity: on ? 1 : 0.6, transition: 'all 0.15s ease',
                      }}
                    >
                      {REQUISITE_VISIBILITY_LABELS[key as keyof typeof REQUISITE_VISIBILITY_LABELS]}: {on ? 'вид.' : 'скр.'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Второй уровень — управляющим; нередактируемый по решению продукта */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>Для управляющих организаций</h3>
          <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-4)', maxWidth: '560px' }}>
            <p className="label-sm" style={{ margin: 0, lineHeight: 1.55 }}>
              Управляющим (Менеджер и выше) организаций, где вы работаете, всегда видны:
              <b> ИИН, дата рождения, адрес проживания, удостоверение личности и основная карта</b> —
              это данные для договоров, трудоустройства и выплат. Отключить их нельзя;
              рядовые коллеги их не видят, пока вы не включите тумблеры выше.
            </p>
          </div>
        </div>
      )}

      {/* === Моя карточка: просмотр + «как видит Группа X» === */}
      {section === 'card' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
            <h2 className="title-lg">Моя карточка</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <span className="label-sm">Как видит:</span>
              <Select
                aria-label="Чьими глазами смотреть на карточку"
                value={previewId}
                onChange={setPreviewId}
                width={240}
                options={[
                  { value: DEFAULT_PREVIEW, label: 'По умолчанию (без группы)' },
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                ]}
              />
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
                <span key={i} className="ui-chip ui-chip--sm">
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
            <div className="alert-accent-inline" style={{ padding: 'var(--spacing-6)', maxWidth: '400px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-3)' }}>
                <span className="title-md" style={{ textTransform: 'capitalize' }}>{p.activeSubscription.plan}</span>
                <span className="ui-chip ui-chip--sm">{p.activeSubscription.status === 'trial' ? 'Пробный период' : p.activeSubscription.status}</span>
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
            <Select
              label="Язык"
              hint="Смена языка — скоро"
              disabled
              value={p.locale || 'ru'}
              onChange={() => {}}
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'kk', label: 'Қазақша' },
                { value: 'en', label: 'English' },
              ]}
            />
            <Input label="Часовой пояс" defaultValue={p.timezone || 'Asia/Almaty'} disabled />
            <Select
              label="Онлайн-статус видят"
              value={p.onlineStatusMode || 'everyone'}
              onChange={async (v) => {
                try { await api.patch('/users/me', { onlineStatusMode: v }); await fetchProfile(); setSuccessMsg('Сохранено'); } catch { setError('Ошибка'); }
              }}
              options={[
                { value: 'everyone', label: 'Все' },
                { value: 'contacts', label: 'Только контакты' },
                { value: 'nobody', label: 'Никто' },
              ]}
            />
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
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Пароль и номер</h3>
            <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.75, maxWidth: '460px', lineHeight: 1.5 }}>
              Обе операции подтверждаются SMS-кодом. Смена номера требует доступ и к текущему,
              и к новому номеру.
            </p>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <button className="btn-ghost-inline" style={{ fontSize: '0.85rem' }} onClick={() => setShowPasswordDialog(true)}>
                Изменить пароль
              </button>
              <button className="btn-ghost-inline" style={{ fontSize: '0.85rem' }} onClick={() => setShowPhoneDialog(true)}>
                Сменить номер телефона
              </button>
            </div>
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

      {/* Смена пароля / номера (движок core/verify) */}
      {showPasswordDialog && <ChangePasswordDialog onClose={() => setShowPasswordDialog(false)} />}
      {showPhoneDialog && <ChangePhoneDialog onClose={() => setShowPhoneDialog(false)} />}

      {/* Delete-account confirmation */}
      {showDeleteModal && (
        <ModalShell onClose={() => !deleting && setShowDeleteModal(false)} zIndex={200}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: '440px', width: '100%', padding: 'var(--spacing-6)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>Удалить аккаунт?</h3>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.55 }}>
              Аккаунт будет помечен на удаление. У вас есть <b>30 дней</b>, чтобы передумать — просто войдите снова, и он восстановится. По истечении срока данные удаляются безвозвратно.
            </p>
            <Input
              label="Текущий пароль"
              type="password"
              autoComplete="current-password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Подтвердите текущим паролем"
              wrapClassName="mb-3"
            />
            {deleteError && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 'var(--spacing-3)' }}>{deleteError}</p>}
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <button className="btn-ghost-inline" disabled={deleting} style={{ fontSize: '0.85rem' }} onClick={() => { setShowDeleteModal(false); setDeletePassword(''); setDeleteError(''); }}>Отмена</button>
              <button disabled={deleting} onClick={handleDeleteAccount} style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '10px', padding: 'var(--spacing-2) var(--spacing-5)', cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1 }}>{deleting ? 'Удаление…' : 'Удалить'}</button>
            </div>
          </div>
        </ModalShell>
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
