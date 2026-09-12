'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { CompanyCard } from '../../CompanyCard';
import { RequisitesSection } from '../RequisitesSection';
import { LegalEntitiesSection } from '../LegalEntitiesSection';
import { WorkspaceNotificationPolicySection } from '../WorkspaceNotificationPolicySection';
import { EntitySelector } from '@/components/EntitySelector';
import { AvatarUploadBlock } from '@/components/files/AvatarUploadBlock';
import {
  Alert, BentoGrid, Button, Card, CardHeader, ConfirmDialog, Divider, Input, LoadingBlock,
  PageHeader, SegmentedControl, Select, StatTile, Textarea, Toggle,
} from '@/components/ui';
import {
  LOCALE_DISPLAY_ORDER,
  LOCALE_NAMES,
  WORKSPACE_LIMITS,
  resolveWorkspaceCardVisibility,
  type Locale,
} from '@superapp/shared';
import { REGION_PROFILE_KZ } from '@superapp/i18n/config';
import { useFormatters } from '@/lib/format';
import { PlanAndLimits } from '@/components/entitlements';
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceCardVisibility,
} from '@superapp/shared';

const KNOWN = ['card', 'anketa', 'stats', 'subscription', 'settings', 'notifications', 'security'] as const;
type Section = (typeof KNOWN)[number];

// Состав тумблеров видимости; подпись каждому даёт каталог
// (`workspaces.profile.visibility.*`). Реквизиты по умолчанию видны: они
// печатаются на каждом счёте, сотрудникам они нужны для работы с клиентами.
// Owner/admin видят и правят всегда.
const VIS_FIELDS: (keyof WorkspaceCardVisibility)[] = [
  'description',
  'industry',
  'city',
  'website',
  'contactEmail',
  'contactPhone',
  'requisites',
];

const emptyForm = {
  name: '',
  logo: '',
  description: '',
  industry: '',
  city: '',
  website: '',
  contactEmail: '',
  contactPhone: '',
  // Язык БУМАГ организации: до загрузки анкеты своего значения нет — умолчание
  // принадлежит рынку, а не клиенту, и приезжает вместе с организацией
  documentLanguage: REGION_PROFILE_KZ.defaultLocale,
};

export default function WorkspaceSectionPage() {
  const t = useTranslations('workspaces');
  const f = useFormatters();
  const { isReady } = useRequireAuth();
  const router = useRouter();
  const { id, section } = useParams<{ id: string; section: string }>();

  const [ws, setWs] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [form, setForm] = useState(emptyForm);
  const [vis, setVis] = useState<WorkspaceCardVisibility>(resolveWorkspaceCardVisibility(null));
  const [saving, setSaving] = useState(false);
  const visTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Card preview ("as members see") + security state
  const [asMember, setAsMember] = useState(false);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [transferTo, setTransferTo] = useState('');
  const [confirm, setConfirm] = useState<null | 'transfer' | 'deactivate'>(null);
  const [busy, setBusy] = useState(false);

  const fetchWs = useCallback(async () => {
    setLoading(true);
    try {
      const w = await apiGet<Workspace>(`/workspaces/${id}`);
      setWs(w);
      setForm({
        name: w.name,
        logo: w.logo ?? '',
        description: w.description ?? '',
        industry: w.industry ?? '',
        city: w.city ?? '',
        website: w.website ?? '',
        contactEmail: w.contactEmail ?? '',
        contactPhone: w.contactPhone ?? '',
        documentLanguage: w.documentLanguage,
      });
      setVis(resolveWorkspaceCardVisibility(w.cardVisibility ?? null));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (isReady) fetchWs();
  }, [isReady, fetchWs]);

  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';

  // Redirect off manage-only sections once the role is known.
  useEffect(() => {
    if (!ws) return;
    if ((section === 'anketa' || section === 'settings' || section === 'notifications' || section === 'subscription') && !canManage) {
      router.replace(`/workspaces/${id}/profile/card`);
    }
    if (section === 'security' && !isOwner) {
      router.replace(`/workspaces/${id}/profile/card`);
    }
  }, [ws, section, canManage, isOwner, id, router]);

  // Load members for the security transfer picker.
  useEffect(() => {
    if (ws && section === 'security' && isOwner) {
      apiGet<WorkspaceMember[]>(`/workspaces/${id}/members`).then(setMembers).catch(() => {});
    }
  }, [ws, section, isOwner, id]);

  if (!isReady || loading || !ws) return <LoadingBlock />;
  if (!KNOWN.includes(section as Section)) {
    router.replace(`/workspaces/${id}/profile/card`);
    return null;
  }

  const clear = () => {
    setError('');
    setSuccess('');
  };

  const saveAnketa = async () => {
    setSaving(true);
    clear();
    try {
      await apiPatch(`/workspaces/${id}`, {
        name: form.name,
        logo: form.logo.trim() || null,
        description: form.description.trim() || null,
        industry: form.industry.trim() || null,
        city: form.city.trim() || null,
        website: form.website.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        documentLanguage: form.documentLanguage,
      });
      setSuccess(t('profile.anketa.saved'));
      await fetchWs();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleVis = (key: keyof WorkspaceCardVisibility, value: boolean) => {
    const next = { ...vis, [key]: value };
    setVis(next);
    if (visTimer.current) clearTimeout(visTimer.current);
    visTimer.current = setTimeout(() => {
      apiPatch(`/workspaces/${id}`, { cardVisibility: next }).catch(() => {});
    }, 600);
  };

  const doTransfer = async () => {
    if (!transferTo) return;
    setBusy(true);
    try {
      await apiPost(`/workspaces/${id}/transfer`, { toUserId: transferTo });
      router.replace(`/workspaces/${id}/profile/card`);
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  const doDeactivate = async () => {
    setBusy(true);
    try {
      await apiDelete(`/workspaces/${id}`);
      router.push('/dashboard');
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  // "As members see" preview hides fields turned off in visibility.
  const previewWs =
    canManage && asMember
      ? {
          ...ws,
          description: vis.description ? ws.description : null,
          industry: vis.industry ? ws.industry : null,
          city: vis.city ? ws.city : null,
          website: vis.website ? ws.website : null,
          contactEmail: vis.contactEmail ? ws.contactEmail : null,
          contactPhone: vis.contactPhone ? ws.contactPhone : null,
        }
      : ws;

  return (
    <>
      <PageHeader
        breadcrumb={ws.name}
        title={t(`profile.sectionTitle.${section as Section}`)}
        actions={
          section === 'card' && canManage ? (
            <SegmentedControl
              aria-label={t('profile.viewAs.aria')}
              value={asMember ? 'member' : 'owner'}
              onChange={(v) => setAsMember(v === 'member')}
              items={[
                { key: 'owner', label: t('profile.viewAs.owner') },
                { key: 'member', label: t('profile.viewAs.member') },
              ]}
            />
          ) : undefined
        }
      />

      {(error || success) && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
          {success && <Alert tone="success" onClose={() => setSuccess('')}>{success}</Alert>}
        </div>
      )}

      {/* ---------- Карточка ---------- */}
      {section === 'card' && (
        <>
          <CompanyCard ws={previewWs} />
          {/* Реквизиты глазами сотрудника: сервер сам отвечает null, если блок скрыт
              настройкой видимости, — тогда карточка ничем не отличается от прежней. */}
          <div style={{ marginTop: 'var(--gap-grid)' }}>
            <BentoGrid>
              <RequisitesSection workspaceId={id} mode="view" span={7} />
            </BentoGrid>
          </div>
        </>
      )}

      {/* ---------- Анкета ---------- */}
      {section === 'anketa' && canManage && (
        <BentoGrid>
          <Card span={7}>
            <CardHeader title={t('profile.anketa.title')} subtitle={t('profile.anketa.subtitle')} />
            <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
              <Input label={t('profile.anketa.name')} value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              {/* Лого через движок файлов (профиль 'avatar', владелец — организация).
                  Сохраняется сразу; старые внешние URL продолжают работать. */}
              <AvatarUploadBlock
                current={form.logo || null}
                fallback="🏢"
                shape="square"
                label={t('profile.anketa.logo')}
                ownerWorkspaceId={id}
                onSaved={async (url) => {
                  await apiPatch(`/workspaces/${id}`, { logo: url });
                  setForm((f) => ({ ...f, logo: url ?? '' }));
                  setSuccess(url ? t('profile.anketa.logoUpdated') : t('profile.anketa.logoRemoved'));
                  await fetchWs();
                }}
              />
              <Textarea
                label={t('profile.anketa.about')}
                value={form.description}
                maxLength={1000}
                rows={3}
                style={{ resize: 'vertical' }}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
              <Input label={t('profile.anketa.industry')} value={form.industry} maxLength={100} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
              <Input label={t('profile.anketa.city')} value={form.city} maxLength={100} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <Input label={t('profile.anketa.website')} value={form.website} maxLength={200} placeholder="https://…" icon="globe" onChange={(e) => setForm({ ...form, website: e.target.value })} />
              <Input label={t('profile.anketa.email')} value={form.contactEmail} maxLength={200} icon="mail" onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              <Input label={t('profile.anketa.phone')} value={form.contactPhone} maxLength={20} icon="call" onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
              {/* Язык БУМАГ организации — не интерфейса: на нём печатаются договоры,
                  приказы и счета. У отдельного бланка язык можно переопределить. */}
              <Select
                label={t('requisites.documentLanguage')}
                value={form.documentLanguage}
                onChange={(v) => setForm({ ...form, documentLanguage: v as Locale })}
                options={LOCALE_DISPLAY_ORDER.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
                hint={t('requisites.documentLanguageHint')}
              />
              <div>
                <Button variant="primary" tone="success" icon="save" loading={saving} onClick={saveAnketa}>
                  {t('profile.anketa.save')}
                </Button>
              </div>
            </div>
          </Card>

          <Card span={5}>
            <CardHeader
              title={t('profile.visibility.title')}
              subtitle={t('profile.visibility.subtitle')}
            />
            <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
              {VIS_FIELDS.map((key) => (
                <Toggle
                  key={key}
                  checked={!!vis[key]}
                  label={t(`profile.visibility.${key}`)}
                  onChange={(v) => toggleVis(key, v)}
                />
              ))}
            </div>
          </Card>

          {/* Юрлица: список ТОО/ИП + реквизиты выбранного (admin+) */}
          <LegalEntitiesSection workspaceId={id} span={12} />
        </BentoGrid>
      )}

      {/* ---------- Статистика ---------- */}
      {section === 'stats' && (
        <BentoGrid>
          <StatTile span={4} label={t('home.stat.members')} value={ws.membersCount} icon="staff" tone="accent" href={`/workspaces/${id}/members`} />
          <StatTile span={4} label={t('home.stat.tasks')} value={ws.tasksCount ?? 0} icon="tasks" tone={ws.tasksCount ? 'success' : 'neutral'} />
          <StatTile
            span={4}
            label={t('home.stat.created')}
            value={f.date(ws.createdAt, 'long')}
            icon="calendar"
            tone="neutral"
          />
        </BentoGrid>
      )}

      {/* ---------- Тариф и лимиты (core/entitlements): владельцу и админам ---------- */}
      {section === 'subscription' && canManage && (
        <PlanAndLimits workspaceId={id} membersHref={`/workspaces/${id}/members`} />
      )}

      {/* ---------- Настройки ---------- */}
      {section === 'settings' && canManage && (
        <BentoGrid>
          <Card span={7}>
            <CardHeader title={t('profile.settings.title')} subtitle={t('profile.settings.subtitle')} />
            <Input label={t('profile.settings.timezone')} value="Asia/Almaty" disabled />
          </Card>
        </BentoGrid>
      )}

      {/* ---------- Уведомления: политика организации (дефолты + замки) ---------- */}
      {section === 'notifications' && canManage && <WorkspaceNotificationPolicySection workspaceId={id} />}

      {/* ---------- Безопасность ---------- */}
      {section === 'security' && isOwner && (
        <>
          <BentoGrid>
            <Card span={7}>
              <CardHeader
                title={t('profile.security.transfer.title')}
                subtitle={t('profile.security.transfer.subtitle')}
              />
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <EntitySelector
                    types={['user']}
                    options={members.filter((m) => m.role !== 'owner').map((m) => ({ type: 'user', id: m.userId, title: m.userName, firstName: m.userName }))}
                    value={transferTo ? [{ type: 'user', id: transferTo }] : []}
                    onChange={(next) => setTransferTo(next[next.length - 1]?.id ?? '')}
                    placeholder={t('profile.security.transfer.pick')}
                  />
                </div>
                <Button variant="outline" icon="crown" disabled={!transferTo || busy} onClick={() => setConfirm('transfer')}>
                  {t('profile.security.transfer.action')}
                </Button>
              </div>
            </Card>

            <Card span={5}>
              <CardHeader title={t('profile.security.danger.title')} subtitle={t('profile.security.danger.subtitle')} />
              <Divider style={{ margin: '0 0 var(--spacing-4)' }} />
              <Button variant="primary" tone="danger" icon="archive" disabled={busy} onClick={() => setConfirm('deactivate')}>
                {t('profile.security.deactivate')}
              </Button>
            </Card>
          </BentoGrid>

          <ConfirmDialog
            open={!!confirm}
            onClose={() => !busy && setConfirm(null)}
            onConfirm={confirm === 'transfer' ? doTransfer : doDeactivate}
            title={
              confirm === 'transfer'
                ? t('profile.security.transfer.confirmTitle')
                : t('profile.security.deactivateConfirmTitle')
            }
            message={
              confirm === 'transfer'
                ? t('profile.security.transfer.confirmMessage')
                : // Срок берётся из константы платформы: «90 дней» в тексте разъезжались бы
                  // с ретеншном при первой же его правке.
                  t('profile.security.deactivateConfirmMessage', {
                    n: WORKSPACE_LIMITS.archiveRetentionDays,
                  })
            }
            confirmLabel={
              confirm === 'transfer'
                ? t('profile.security.transfer.action')
                : t('profile.security.deactivate')
            }
            danger
            loading={busy}
          />
        </>
      )}
    </>
  );
}
