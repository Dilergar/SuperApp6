'use client';

import { Button, Chip, Input, ModalShell, Select } from '@/components/ui';
import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { apiDelete, apiErrorMessage, apiGet, apiPatch } from '@/lib/api';
import { useConfirm } from '@/components/ui/useConfirm';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useFormatters } from '@/lib/format';
import { useLocale, useTranslations } from 'next-intl';
import {
  REQUISITE_VISIBILITY_EXTRAS,
  isValidIinOrBin,
  resolveCardVisibility,
  type CardVisibility,
  type Circle,
  type SessionInfo,
} from '@superapp/shared';
import { PersonCard } from '../../circles/PersonCard';
import { WalletSection } from '../WalletSection';
import { SkinsSection } from '../SkinsSection';
import { NotificationsSection } from '../NotificationsSection';
import { AnalyticsConsentSection } from '../AnalyticsConsentSection';
import { AvatarUploadBlock } from '@/components/files/AvatarUploadBlock';
import { ChangePasswordDialog, ChangePhoneDialog } from './security-dialogs';
import type { CardSkinRender } from '../../circles/card-skin';
import { PlanAndLimits } from '@/components/entitlements';

// ============================================================
// Types & constants
// ============================================================

type Section = 'form' | 'card' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'notifications' | 'security';

const KNOWN_SECTIONS: Section[] = ['form', 'card', 'skins', 'wallet', 'stats', 'roles', 'subscription', 'settings', 'notifications', 'security'];

/** Значения перечисления + ключи каталога: подписи собираются в компоненте. */
const MARITAL_VALUES = ['', 'single', 'married', 'relationship', 'divorced', 'widowed'] as const;
const MARITAL_KEYS: Record<string, string> = {
  '': 'form.marital.none',
  single: 'form.marital.single',
  married: 'form.marital.married',
  relationship: 'form.marital.relationship',
  divorced: 'form.marital.divorced',
  widowed: 'form.marital.widowed',
};

/**
 * Названия месяцев для раздельного ввода даты рождения даёт `Intl` НА ЯЗЫКЕ
 * зрителя — родительный падеж («января») там, где язык его требует.
 */
function monthOptionNames(locale: string): string[] {
  const f = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) =>
    // Из «1 января» берём только месяц: отдельного «genitive month» в Intl нет.
    f.format(new Date(Date.UTC(2021, i, 1))).replace(/^\s*\d+\s*/, '').trim(),
  );
}

type VisField =
  | 'city' | 'bio' | 'dateOfBirth' | 'age'
  | 'maritalStatus' | 'email' | 'socialLinks' | 'onlineStatus';

const FIELD_KEYS: VisField[] = [
  'city', 'bio', 'dateOfBirth', 'age', 'maritalStatus', 'email', 'socialLinks', 'onlineStatus',
];

const DEFAULT_PREVIEW = '__default__';

// ============================================================
// Section content (chrome — nav + sidebar — lives in layout.tsx)
// ============================================================

export default function ProfileSectionPage() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const locale = useLocale();
  // Даты и числа — через форматтеры платформы (регион КЗ), а не toLocaleString('ru-RU').
  const fmt = useFormatters();
  const router = useRouter();
  const params = useParams<{ section: string }>();
  const rawSection = (params?.section ?? 'card') as Section;
  const section: Section = KNOWN_SECTIONS.includes(rawSection) ? rawSection : 'card';

  const { isReady, user: profile } = useRequireAuth();
  const logout = useAuthStore((s) => s.logout);
  const fetchProfile = useAuthStore((s) => s.fetchProfile);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [confirm, confirmUI] = useConfirm();
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
    middleName: '', iin: '', residentialAddress: '', idDocNumber: '', idDocIssuedBy: '', idDocIssuedAt: '',
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
        middleName: profile.middleName || '',
        iin: profile.iin || '',
        residentialAddress: profile.residentialAddress || '',
        idDocNumber: profile.idDocNumber || '',
        idDocIssuedBy: profile.idDocIssuedBy || '',
        idDocIssuedAt: profile.idDocIssuedAt || '',
      });
    }
  }, [profile]);

  // Seed default visibility once (later refetch must not clobber edits).
  useEffect(() => {
    if (profile && !visSeeded.current) {
      setVis(resolveCardVisibility(profile.cardVisibility ?? null));
      setVisCompany(resolveCardVisibility(profile.companyCardVisibility ?? null));
      visSeeded.current = true;
    }
  }, [profile]);

  // Groups — for the per-group preview selector.
  useEffect(() => {
    if (!isReady) return;
    apiGet<Circle[]>('/circles').then(setGroups).catch(() => {});
  }, [isReady]);

  // My equipped default skin — resolve(self) returns my default (no self-group overrides).
  useEffect(() => {
    const id = profile?.id;
    if (!isReady || !id) return;
    apiGet<Record<string, CardSkinRender | null>>('/card-skins/resolve', { params: { userIds: id } })
      .then((map) => setMySkin(map[id] ?? null))
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
    if (!deletePassword) { setDeleteError(t('delete.enterPassword')); return; }
    setDeleting(true);
    try {
      // Schedules deletion (30-day grace) and revokes sessions server-side.
      await apiDelete('/users/me', { data: { password: deletePassword } });
      await logout(); // clear local state + redirect with a recovery hint
      router.push('/login?deleted=1');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setDeleteError(axiosErr.response?.data?.message || t('delete.failed'));
      setDeleting(false);
    }
  };

  const handleSaveProfile = async () => {
    clear();
    if (!editData.firstName.trim()) {
      setError(t('form.firstNameRequired'));
      return;
    }
    // Дата рождения собирается из трёх полей; заполнена частично — честная ошибка,
    // а не молча сохранённая пустота.
    const dobParts = [editData.dobDay, editData.dobMonth, editData.dobYear];
    const dobFilled = dobParts.filter((p) => p !== '').length;
    if (dobFilled > 0 && dobFilled < 3) {
      setError(t('form.dobPartial'));
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
        setError(t('form.dobInvalid'));
        return;
      }
      dateOfBirth = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (editData.iin.trim() && !isValidIinOrBin(editData.iin.trim())) {
      setError(t('form.iinInvalidLong'));
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
      payload.middleName = editData.middleName.trim() || null;
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

      await apiPatch('/users/me', payload);
      await fetchProfile();
      setSuccessMsg(t('form.saved'));
    } catch (err: unknown) {
      const a = err as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || t('form.saveFailed'));
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
        await apiPatch('/users/me', { cardVisibility: next });
        setSuccessMsg(t('visibility.savedDefault'));
      } catch {
        setError(t('visibility.saveFailed'));
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
        await apiPatch('/users/me', { companyCardVisibility: next });
        setSuccessMsg(t('visibility.savedCompany'));
      } catch {
        setError(t('visibility.saveFailed'));
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
        await apiPatch('/users/me', { companyCardVisibility: next });
        setSuccessMsg(t('visibility.savedCompany'));
      } catch {
        setError(t('visibility.saveFailed'));
      }
    }, 600);
  };

  const fetchSessions = async () => {
    try {
      setSessions(await apiGet<SessionInfo[]>('/users/me/sessions'));
    } catch {
      setError(t('security.sessionsFailed'));
    }
  };

  const dropSession = async (sessionId: string) => {
    try {
      await apiDelete(`/users/me/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setSuccessMsg(t('security.sessionEnded'));
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteSession = (session: SessionInfo) => {
    clear();
    // Завершить СВОЮ сессию можно, но молча это делать нельзя: человек выйдет прямо
    // здесь. Раньше кнопка ничем не отличалась от «закрыть чужое устройство», а
    // маркера «Текущая» не было вовсе — сервер его не считал.
    if (session.isCurrent) {
      confirm(
        {
          title: t('security.currentTitle'),
          message: t('security.currentText'),
          confirmLabel: t('security.currentConfirm'),
          danger: true,
        },
        () => dropSession(session.id),
      );
      return;
    }
    void dropSession(session.id);
  };

  useEffect(() => {
    if (section === 'security' && isReady) fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, isReady]);

  if (!isReady || !profile) {
    return <p className="label-md" style={{ fontSize: '1rem' }}>{common('state.loading')}</p>;
  }

  const p = profile;
  const previewGroup = groups.find((g) => g.id === previewId) ?? null;
  const previewVis = previewGroup
    ? resolveCardVisibility(previewGroup.cardVisibility)
    : resolveCardVisibility(vis ?? p.cardVisibility ?? null);
  const previewLabel = previewGroup ? previewGroup.name : t('card.defaultGroup');
  const monthNames = monthOptionNames(locale);
  const maritalOptions = MARITAL_VALUES.map((v) => ({ value: v as string, label: t(MARITAL_KEYS[v]) }));
  const fieldMeta = FIELD_KEYS.map((key) => ({ key, label: t(`field.${key}`) }));

  return (
    <div>
      {/* Messages */}
      {error && <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
      {successMsg && <div className="alert-accent-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{successMsg}</div>}

      {/* === Моя Анкета: данные + видимость по умолчанию === */}
      {section === 'form' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('form.title')}</h2>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)', opacity: 0.7 }}>
            {t('form.subtitle')}
          </p>

          <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '560px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
              {/* Аватарка через движок файлов (профиль 'avatar', публичная вечная ссылка).
                  Сохраняется сразу, не через кнопку «Сохранить анкету». */}
              <AvatarUploadBlock
                current={profile?.avatar ?? null}
                fallback={(profile?.firstName?.[0] ?? '?').toUpperCase()}
                label={t('form.avatar')}
                onSaved={async (url) => {
                  await apiPatch('/users/me', { avatar: url });
                  await fetchProfile();
                  setSuccessMsg(url ? t('form.photoUpdated') : t('form.photoRemoved'));
                  setTimeout(() => setSuccessMsg(''), 2500);
                }}
              />
              {/* Поля — из кита: он сам связывает подпись с полем (htmlFor+id).
                  Раньше подписи стояли отдельными <label> без связи, и ни одно поле
                  анкеты не имело имени для скринридера, а клик по подписи не наводил
                  курсор в поле. */}
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input label={t('form.firstName')} required value={editData.firstName} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} />
                <Input label={t('form.lastName')} value={editData.lastName} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} />
              </div>
              <Input
                label={t('form.bio')}
                hint={t('form.bioHint', { n: editData.bio.length })}
                value={editData.bio}
                onChange={(e) => setEditData({ ...editData, bio: e.target.value.slice(0, 160) })}
                placeholder={t('form.bioPlaceholder')}
              />
              <Input label={t('form.city')} value={editData.city} onChange={(e) => setEditData({ ...editData, city: e.target.value })} />
              {/* Дата рождения — три поля (день / месяц названием / год), решение продукта */}
              <div>
                <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>{t('form.dob')}</span>
                <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: 'var(--spacing-3)' }}>
                  <Input
                    aria-label={t('form.dobDay')}
                    inputMode="numeric"
                    placeholder={t('form.dobDayShort')}
                    value={editData.dobDay}
                    onChange={(e) => setEditData({ ...editData, dobDay: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                  />
                  <Select
                    aria-label={t('form.dobMonth')}
                    value={editData.dobMonth}
                    onChange={(v) => setEditData({ ...editData, dobMonth: v })}
                    options={[
                      { value: '', label: t('form.dobMonthShort') },
                      ...monthNames.map((m, i) => ({ value: String(i), label: m })),
                    ]}
                  />
                  <Input
                    aria-label={t('form.dobYear')}
                    inputMode="numeric"
                    placeholder={t('form.dobYearShort')}
                    value={editData.dobYear}
                    onChange={(e) => setEditData({ ...editData, dobYear: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  />
                </div>
              </div>
              <Input label="Email" type="email" value={editData.email} onChange={(e) => setEditData({ ...editData, email: e.target.value })} placeholder="user@example.com" />
              <Select
                label={t('form.maritalStatus')}
                value={editData.maritalStatus}
                onChange={(v) => setEditData({ ...editData, maritalStatus: v })}
                options={maritalOptions}
              />
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input label="Telegram" value={editData.telegram} onChange={(e) => setEditData({ ...editData, telegram: e.target.value })} placeholder="@username" />
                <Input label="Instagram" value={editData.instagram} onChange={(e) => setEditData({ ...editData, instagram: e.target.value })} placeholder="@username" />
                <Input label="LinkedIn" value={editData.linkedin} onChange={(e) => setEditData({ ...editData, linkedin: e.target.value })} placeholder="linkedin.com/in/..." />
                <Input label="WhatsApp" value={editData.whatsapp} onChange={(e) => setEditData({ ...editData, whatsapp: e.target.value })} placeholder="+77001234567" />
              </div>
              {/* ---- Реквизиты: комплект для трудового договора и выплат ---- */}
              <h3 className="title-md" style={{ margin: 'var(--spacing-4) 0 0' }}>{t('form.requisitesTitle')}</h3>
              <p className="label-sm" style={{ margin: 0, opacity: 0.7, lineHeight: 1.5 }}>
                {t('form.requisitesText')}
              </p>
              <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
                <Input
                  label={t('form.middleName')}
                  hint={t('form.middleNameHint')}
                  value={editData.middleName}
                  onChange={(e) => setEditData({ ...editData, middleName: e.target.value })}
                />
                <Input
                  label={t('form.iin')}
                  inputMode="numeric"
                  placeholder={t('form.iinPlaceholder')}
                  value={editData.iin}
                  onChange={(e) => setEditData({ ...editData, iin: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                  error={editData.iin && !isValidIinOrBin(editData.iin) ? t('form.iinInvalid') : undefined}
                />
                <Input
                  label={t('form.address')}
                  value={editData.residentialAddress}
                  onChange={(e) => setEditData({ ...editData, residentialAddress: e.target.value })}

                />
              </div>
              <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-4)' }}>
                <Input
                  label={t('form.idNumber')}
                  value={editData.idDocNumber}
                  onChange={(e) => setEditData({ ...editData, idDocNumber: e.target.value })}
                  placeholder="0XXXXXXXX"
                />
                <Input
                  label={t('form.idIssuedBy')}
                  value={editData.idDocIssuedBy}
                  onChange={(e) => setEditData({ ...editData, idDocIssuedBy: e.target.value })}

                />
                <Input
                  label={t('form.idIssuedAt')}
                  type="date"
                  value={editData.idDocIssuedAt}
                  onChange={(e) => setEditData({ ...editData, idDocIssuedAt: e.target.value })}
                />
              </div>
              <p className="label-sm" style={{ margin: 0, opacity: 0.7 }}>
                {t('form.payoutCardNote')}
              </p>
              <Button variant="primary" tone="success" onClick={handleSaveProfile} style={{ marginTop: 'var(--spacing-2)', alignSelf: 'flex-start' }}>
                {t('form.save')}
              </Button>
            </div>
          </div>

          {/* Default visibility (for people in no group) */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>{t('visibility.defaultTitle')}</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            {t('visibility.defaultText')}
          </p>
          {vis && (
            <div className="card-elevated" style={{ padding: 'var(--spacing-4)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {fieldMeta.map((f) => {
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
                      {f.label}: {on ? t('visibility.on') : t('visibility.off')}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Видимость в Компаниях (что видят коллеги по организациям) */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>{t('visibility.companyTitle')}</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            {t('visibility.companyText')}
          </p>
          {visCompany && (
            <div className="card-elevated" style={{ padding: 'var(--spacing-4)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
                {fieldMeta.map((f) => {
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
                      {f.label}: {on ? t('visibility.on') : t('visibility.off')}
                    </button>
                  );
                })}
              </div>
              {/* Конфиденциальные реквизиты коллегам — по умолчанию ВЫКЛЮЧЕНЫ */}
              <p className="label-sm" style={{ margin: 'var(--spacing-4) 0 var(--spacing-2)', opacity: 0.7 }}>
                {t('visibility.confidential')}
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
                      {t(`requisite.${key}`)}: {on ? t('visibility.on') : t('visibility.off')}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Второй уровень — управляющим; нередактируемый по решению продукта */}
          <h3 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-1)' }}>{t('visibility.managersTitle')}</h3>
          <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-4)', maxWidth: '560px' }}>
            <p className="label-sm" style={{ margin: 0, lineHeight: 1.55 }}>
              {t('visibility.managersText')}
              <b>{t('visibility.managersList')}</b>{' '}
              {t('visibility.managersTail')}
            </p>
          </div>
        </div>
      )}

      {/* === Моя карточка: просмотр + «как видит Группа X» === */}
      {section === 'card' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
            <h2 className="title-lg">{t('card.title')}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
              <span className="label-sm">{t('card.seenBy')}</span>
              <Select
                aria-label={t('card.previewAria')}
                value={previewId}
                onChange={setPreviewId}
                width={240}
                options={[
                  { value: DEFAULT_PREVIEW, label: t('card.defaultGroup') },
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                ]}
              />
            </div>
          </div>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            {t('card.note', { name: previewLabel })}
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
      {section === 'skins' && <SkinsSection profile={profile} />}

      {/* === Кошелёк === */}
      {section === 'wallet' && <WalletSection />}

      {section === 'notifications' && <NotificationsSection />}

      {/* === Stats === */}
      {section === 'stats' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('stats.title')}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 'var(--spacing-4)' }}>
            <StatTile label={t('stats.people')} value={p.contactsCount ?? 0} />
            <StatTile label={t('stats.groups')} value={p.circlesCount ?? 0} />
            <StatTile label={t('stats.workspaces')} value={p.workspacesCount ?? 0} />
            <StatTile
              label={t('stats.memberSince')}
              value={p.createdAt ? fmt.date(p.createdAt, 'monthYear') : common('labels.dash')}
            />
          </div>
        </div>
      )}

      {/* === Roles === */}
      {section === 'roles' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('roles.title')}</h2>
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
            <p className="label-md">{t('roles.empty')}</p>
          )}
        </div>
      )}

      {/* === Subscription === */}
      {/* === Тариф и лимиты (core/entitlements) === */}
      {section === 'subscription' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('subscription.title')}</h2>
          <PlanAndLimits />
        </div>
      )}

      {/* === Settings === */}
      {section === 'settings' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('settings.title')}</h2>
          <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
            <h3 className="title-md" style={{ margin: 0 }}>{t('language.section')}</h3>
            {/*
              ОДИН тумблер «Язык» — форматы дат и чисел ему не подчиняются: они
              принадлежат РЕГИОНУ (Казахстан), и человек, выбравший English,
              по-прежнему видит 03.09.2026 и 12 500 ₸. Регион станет отдельной
              настройкой позже — модель уже разделена, рефакторинг не понадобится.
            */}
            <LanguageSwitcher label={t('language.label')} width="100%" />
            <Input
              label={t('language.regionLabel')}
              value={t('language.regionValue')}
              hint={t('language.regionHint')}
              readOnly
              disabled
            />
            <Input
              label={t('language.timezoneLabel')}
              defaultValue={p.timezone || 'Asia/Almaty'}
              hint={t('language.timezoneHint')}
              disabled
            />
            <Select
              label={t('settings.onlineStatus')}
              value={p.onlineStatusMode || 'everyone'}
              onChange={async (v) => {
                try { await apiPatch('/users/me', { onlineStatusMode: v }); await fetchProfile(); setSuccessMsg(t('settings.saved')); } catch { setError(t('settings.saveFailed')); }
              }}
              options={[
                { value: 'everyone', label: t('settings.online.everyone') },
                { value: 'contacts', label: t('settings.online.contacts') },
                { value: 'nobody', label: t('settings.online.nobody') },
              ]}
            />
          </div>
          <AnalyticsConsentSection />
        </div>
      )}

      {/* === Security === */}
      {section === 'security' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('security.title')}</h2>

          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{t('security.sessions')}</h3>
          {confirmUI}
          {sessions.length === 0 ? (
            <p className="label-md">{t('security.noSessions')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', maxWidth: '500px' }}>
              {sessions.map((s) => (
                <div key={s.id} className="card" style={{ padding: 'var(--spacing-4)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                      {s.deviceInfo || t('security.unknownDevice')}
                      {s.isCurrent && <Chip tone="accent" size="sm">{t('security.current')}</Chip>}
                    </div>
                    <div className="label-sm">{t('security.lastActive', { date: fmt.dateTime(s.lastActive) })}</div>
                  </div>
                  <button onClick={() => handleDeleteSession(s)}
                    style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}
                  >
                    {t('security.endSession')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 'var(--spacing-8)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('security.passwordPhone')}</h3>
            <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.75, maxWidth: '460px', lineHeight: 1.5 }}>
              {t('security.passwordPhoneText')}
            </p>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <button className="btn-ghost-inline" style={{ fontSize: '0.85rem' }} onClick={() => setShowPasswordDialog(true)}>
                {t('security.changePassword')}
              </button>
              <button className="btn-ghost-inline" style={{ fontSize: '0.85rem' }} onClick={() => setShowPhoneDialog(true)}>
                {t('security.changePhone')}
              </button>
            </div>
          </div>

          <div style={{ marginTop: 'var(--spacing-8)' }}>
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>{t('security.dangerZone')}</h3>
            <button
              onClick={() => { setShowDeleteModal(true); setDeletePassword(''); setDeleteError(''); }}
              style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--danger)', background: 'none', border: '1.5px solid var(--danger)', borderRadius: '10px', padding: 'var(--spacing-2) var(--spacing-4)', cursor: 'pointer' }}
            >
              {t('security.deleteAccount')}
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
            <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>{t('delete.title')}</h3>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.55 }}>
              {t('delete.textBefore')}<b>{t('delete.days')}</b>{t('delete.textAfter')}
            </p>
            <Input
              label={t('delete.password')}
              type="password"
              autoComplete="current-password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder={t('delete.passwordPlaceholder')}
              wrapClassName="mb-3"
            />
            {deleteError && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 'var(--spacing-3)' }}>{deleteError}</p>}
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
              <button className="btn-ghost-inline" disabled={deleting} style={{ fontSize: '0.85rem' }} onClick={() => { setShowDeleteModal(false); setDeletePassword(''); setDeleteError(''); }}>{common('actions.cancel')}</button>
              <button disabled={deleting} onClick={handleDeleteAccount} style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--on-primary)', background: 'var(--danger)', border: 'none', borderRadius: '10px', padding: 'var(--spacing-2) var(--spacing-5)', cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1 }}>{deleting ? t('delete.deleting') : t('delete.submit')}</button>
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
