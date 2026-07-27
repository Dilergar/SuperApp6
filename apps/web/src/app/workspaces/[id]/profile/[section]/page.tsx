'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import { CompanyCard } from '../../CompanyCard';
import { EntitySelector } from '@/components/EntitySelector';
import { AvatarUploadBlock } from '@/components/files/AvatarUploadBlock';
import {
  Alert, BentoGrid, Button, Card, CardHeader, ConfirmDialog, Divider, Input, LoadingBlock,
  PageHeader, SegmentedControl, StatTile, Textarea, Toggle,
} from '@/components/ui';
import { resolveWorkspaceCardVisibility } from '@superapp/shared';
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceCardVisibility,
} from '@superapp/shared';

const KNOWN = ['card', 'anketa', 'stats', 'subscription', 'settings', 'security'] as const;
type Section = (typeof KNOWN)[number];

const SECTION_TITLE: Record<Section, string> = {
  card: 'Карточка компании',
  anketa: 'Анкета компании',
  stats: 'Статистика',
  subscription: 'Подписка',
  settings: 'Настройки',
  security: 'Безопасность',
};

const VIS_FIELDS: { key: keyof WorkspaceCardVisibility; label: string }[] = [
  { key: 'description', label: 'Описание' },
  { key: 'industry', label: 'Отрасль' },
  { key: 'city', label: 'Город' },
  { key: 'website', label: 'Сайт' },
  { key: 'contactEmail', label: 'Email' },
  { key: 'contactPhone', label: 'Телефон' },
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
};

export default function WorkspaceSectionPage() {
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
      const r = await api.get(`/workspaces/${id}`);
      const w: Workspace = r.data.data;
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
    if ((section === 'anketa' || section === 'settings') && !canManage) {
      router.replace(`/workspaces/${id}/profile/card`);
    }
    if (section === 'security' && !isOwner) {
      router.replace(`/workspaces/${id}/profile/card`);
    }
  }, [ws, section, canManage, isOwner, id, router]);

  // Load members for the security transfer picker.
  useEffect(() => {
    if (ws && section === 'security' && isOwner) {
      api.get(`/workspaces/${id}/members`).then((r) => setMembers(r.data.data)).catch(() => {});
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
      await api.patch(`/workspaces/${id}`, {
        name: form.name,
        logo: form.logo.trim() || null,
        description: form.description.trim() || null,
        industry: form.industry.trim() || null,
        city: form.city.trim() || null,
        website: form.website.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
      });
      setSuccess('Анкета сохранена');
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
      api.patch(`/workspaces/${id}`, { cardVisibility: next }).catch(() => {});
    }, 600);
  };

  const doTransfer = async () => {
    if (!transferTo) return;
    setBusy(true);
    try {
      await api.post(`/workspaces/${id}/transfer`, { toUserId: transferTo });
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
      await api.delete(`/workspaces/${id}`);
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
        title={SECTION_TITLE[section as Section]}
        actions={
          section === 'card' && canManage ? (
            <SegmentedControl
              aria-label="Чьими глазами смотреть карточку"
              value={asMember ? 'member' : 'owner'}
              onChange={(v) => setAsMember(v === 'member')}
              items={[
                { key: 'owner', label: 'Как видите вы' },
                { key: 'member', label: 'Как видят сотрудники' },
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
      {section === 'card' && <CompanyCard ws={previewWs} />}

      {/* ---------- Анкета ---------- */}
      {section === 'anketa' && canManage && (
        <BentoGrid>
          <Card span={7}>
            <CardHeader title="Данные компании" subtitle="Название и логотип видны всем сотрудникам всегда" />
            <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
              <Input label="Название" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              {/* Лого через движок файлов (профиль 'avatar', владелец — организация).
                  Сохраняется сразу; старые внешние URL продолжают работать. */}
              <AvatarUploadBlock
                current={form.logo || null}
                fallback="🏢"
                shape="square"
                label="Логотип"
                ownerWorkspaceId={id}
                onSaved={async (url) => {
                  await api.patch(`/workspaces/${id}`, { logo: url });
                  setForm((f) => ({ ...f, logo: url ?? '' }));
                  setSuccess(url ? 'Логотип обновлён' : 'Логотип удалён');
                  await fetchWs();
                }}
              />
              <Textarea
                label="О компании"
                value={form.description}
                maxLength={1000}
                rows={3}
                style={{ resize: 'vertical' }}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
              <Input label="Отрасль" value={form.industry} maxLength={100} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
              <Input label="Город" value={form.city} maxLength={100} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <Input label="Сайт" value={form.website} maxLength={200} placeholder="https://…" icon="globe" onChange={(e) => setForm({ ...form, website: e.target.value })} />
              <Input label="Email" value={form.contactEmail} maxLength={200} icon="mail" onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              <Input label="Телефон" value={form.contactPhone} maxLength={20} icon="call" onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
              <div>
                <Button variant="primary" tone="success" icon="save" loading={saving} onClick={saveAnketa}>
                  Сохранить анкету
                </Button>
              </div>
            </div>
          </Card>

          <Card span={5}>
            <CardHeader
              title="Видимость для сотрудников"
              subtitle="Что сотрудники видят в карточке компании. Название и логотип видны всегда"
            />
            <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
              {VIS_FIELDS.map((f) => (
                <Toggle key={f.key} checked={!!vis[f.key]} label={f.label} onChange={(v) => toggleVis(f.key, v)} />
              ))}
            </div>
          </Card>
        </BentoGrid>
      )}

      {/* ---------- Статистика ---------- */}
      {section === 'stats' && (
        <BentoGrid>
          <StatTile span={4} label="Сотрудников" value={ws.membersCount} icon="staff" tone="accent" href={`/workspaces/${id}/members`} />
          <StatTile span={4} label="Задач" value={ws.tasksCount ?? 0} icon="tasks" tone={ws.tasksCount ? 'success' : 'neutral'} />
          <StatTile
            span={4}
            label="Создана"
            value={new Date(ws.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
            icon="calendar"
            tone="neutral"
          />
        </BentoGrid>
      )}

      {/* ---------- Подписка ---------- */}
      {section === 'subscription' && (
        <BentoGrid>
          <Card span={7}>
            <CardHeader title="Текущий план организации" subtitle="Платные планы для организаций появятся позже" />
            <div className="title-lg" style={{ marginBottom: 'var(--spacing-4)' }}>Бесплатный</div>
            <Button variant="primary" icon="crown" disabled>Улучшить (скоро)</Button>
          </Card>
        </BentoGrid>
      )}

      {/* ---------- Настройки ---------- */}
      {section === 'settings' && canManage && (
        <BentoGrid>
          <Card span={7}>
            <CardHeader title="Общие настройки" subtitle="Дополнительные настройки организации появятся позже" />
            <Input label="Часовой пояс" value="Asia/Almaty" disabled />
          </Card>
        </BentoGrid>
      )}

      {/* ---------- Безопасность ---------- */}
      {section === 'security' && isOwner && (
        <>
          <BentoGrid>
            <Card span={7}>
              <CardHeader
                title="Передать владение"
                subtitle="Новый владелец получит полные права, вы станете администратором"
              />
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <EntitySelector
                    types={['user']}
                    options={members.filter((m) => m.role !== 'owner').map((m) => ({ type: 'user', id: m.userId, title: m.userName, firstName: m.userName }))}
                    value={transferTo ? [{ type: 'user', id: transferTo }] : []}
                    onChange={(next) => setTransferTo(next[next.length - 1]?.id ?? '')}
                    placeholder="Выберите сотрудника…"
                  />
                </div>
                <Button variant="outline" icon="crown" disabled={!transferTo || busy} onClick={() => setConfirm('transfer')}>
                  Передать
                </Button>
              </div>
            </Card>

            <Card span={5}>
              <CardHeader title="Опасная зона" subtitle="Деактивация скроет организацию. Данные сохраняются" />
              <Divider style={{ margin: '0 0 var(--spacing-4)' }} />
              <Button variant="primary" tone="danger" icon="archive" disabled={busy} onClick={() => setConfirm('deactivate')}>
                Деактивировать организацию
              </Button>
            </Card>
          </BentoGrid>

          <ConfirmDialog
            open={!!confirm}
            onClose={() => !busy && setConfirm(null)}
            onConfirm={confirm === 'transfer' ? doTransfer : doDeactivate}
            title={confirm === 'transfer' ? 'Передать владение?' : 'Деактивировать организацию?'}
            message={
              confirm === 'transfer'
                ? 'Вы передадите права владельца другому сотруднику. Вернуть их сможет только он.'
                : 'Организация уйдёт в архив на 90 дней — вернуть её можно из блока «Архив» на главной. После этого она удаляется навсегда.'
            }
            confirmLabel={confirm === 'transfer' ? 'Передать' : 'Деактивировать'}
            danger
            loading={busy}
          />
        </>
      )}
    </>
  );
}
