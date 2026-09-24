'use client';

import { Button, Input, LoadingBlock, Select } from '@/components/ui';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { useAuthStore } from '@/lib/stores/auth';
import { apiGet, apiPatch } from '@/lib/api';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useFormatters } from '@/lib/format';
import { useLocale, useTranslations } from 'next-intl';
import { isValidIinOrBin } from '@superapp/shared';
import { CardVisibilitySection } from '../CardVisibilitySection';
import { WalletSection } from '../WalletSection';
import { SkinsSection } from '../SkinsSection';
import { NotificationsSection } from '../NotificationsSection';
import { KeysSection } from '../KeysSection';
import { AvatarUploadBlock } from '@/components/files/AvatarUploadBlock';
import { SecuritySection } from '@/components/security/SecuritySection';
import { LazyNamespace } from '@/i18n/LazyNamespace';
import type { CardSkinRender } from '../../circles/card-skin';
import { PlanAndLimits } from '@/components/entitlements';

// ============================================================
// Types & constants
// ============================================================

type Section = 'form' | 'card' | 'skins' | 'wallet' | 'stats' | 'roles' | 'subscription' | 'settings' | 'notifications' | 'security' | 'keys';

const KNOWN_SECTIONS: Section[] = ['form', 'card', 'skins', 'wallet', 'stats', 'roles', 'subscription', 'settings', 'notifications', 'security', 'keys'];

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

// ============================================================
// Section content (chrome — nav + sidebar — lives in layout.tsx)
// ============================================================

export default function ProfileSectionPage() {
  const t = useTranslations('profile');
  const tv = useTranslations('visibility');
  const common = useTranslations('common');
  const locale = useLocale();
  // Даты и числа — через форматтеры платформы (регион КЗ), а не toLocaleString('ru-RU').
  const fmt = useFormatters();
  const params = useParams<{ section: string }>();
  const rawSection = (params?.section ?? 'card') as Section;
  const section: Section = KNOWN_SECTIONS.includes(rawSection) ? rawSection : 'card';

  const { isReady, user: profile } = useRequireAuth();
  const fetchProfile = useAuthStore((s) => s.fetchProfile);

  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [editData, setEditData] = useState({
    firstName: '', lastName: '', bio: '', city: '', email: '',
    maritalStatus: '', telegram: '', instagram: '', linkedin: '', whatsapp: '',
    // Дата рождения — ТРИ поля (день / месяц названием / год), решение продукта.
    dobDay: '', dobMonth: '', dobYear: '',
    // Реквизиты «Для договоров и трудоустройства».
    middleName: '', iin: '', residentialAddress: '', idDocNumber: '', idDocIssuedBy: '', idDocIssuedAt: '',
  });

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

  // My equipped default skin — resolve(self) returns my default (no self-group overrides).
  useEffect(() => {
    const id = profile?.id;
    if (!isReady || !id) return;
    apiGet<Record<string, CardSkinRender | null>>('/card-skins/resolve', { params: { userIds: id } })
      .then((map) => setMySkin(map[id] ?? null))
      .catch(() => {});
  }, [isReady, profile]);

  const clear = () => { setError(''); setSuccessMsg(''); };

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

  if (!isReady || !profile) {
    return <p className="label-md" style={{ fontSize: '1rem' }}>{common('state.loading')}</p>;
  }

  const p = profile;
  const monthNames = monthOptionNames(locale);
  const maritalOptions = MARITAL_VALUES.map((v) => ({ value: v as string, label: t(MARITAL_KEYS[v]) }));

  return (
    <div>
      {/* Messages */}
      {error && <div className="alert-neutral-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--primary)', fontSize: '0.875rem' }}>{error}</div>}
      {successMsg && <div className="alert-accent-inline" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)', color: 'var(--secondary)', fontSize: '0.875rem' }}>{successMsg}</div>}

      {/* === Моя Анкета: ТОЛЬКО данные (кто что видит — «Моя карточка и видимость») === */}
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
              {/* Служебные поля: их видимость — политика организации, не тумблер человека */}
              <p className="label-sm" style={{ margin: 0, opacity: 0.7, lineHeight: 1.5 }}>
                {tv('personal.requisitesNote')}
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

        </div>
      )}

      {/* === Моя карточка и видимость (core/visibility) === */}
      {section === 'card' && <CardVisibilitySection skin={mySkin ?? undefined} />}

      {/* === Скины карточки === */}
      {section === 'skins' && <SkinsSection profile={profile} />}

      {/* === Кошелёк === */}
      {section === 'wallet' && <WalletSection />}

      {section === 'notifications' && <NotificationsSection />}

      {/* === Ключи и приложения (core/keys): личные ключи для собственных данных === */}
      {section === 'keys' && <KeysSection />}

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
          </div>
        </div>
      )}

      {/* === Security === (core/audit: устройства, сессии, лента, «Это не я») */}
      {section === 'security' && (
        <div>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>{t('security.title')}</h2>
          <LazyNamespace ns="audit" fallback={<LoadingBlock />}>
            <SecuritySection />
          </LazyNamespace>
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
