'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import { CompanyCard } from '../../CompanyCard';
import { EntitySelector } from '@/components/EntitySelector';
import { resolveWorkspaceCardVisibility } from '@superapp/shared';
import type {
  Workspace,
  WorkspaceMember,
  WorkspaceCardVisibility,
} from '@superapp/shared';

const KNOWN = ['card', 'anketa', 'stats', 'subscription', 'settings', 'security'] as const;
type Section = (typeof KNOWN)[number];

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
    } catch {
      setError('Не удалось загрузить организацию');
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

  if (!isReady || loading || !ws) return <p className="label-md">Загрузка…</p>;
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
      setError(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          'Не удалось сохранить',
      );
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
    } catch {
      setError('Не удалось передать владение');
      setBusy(false);
      setConfirm(null);
    }
  };

  const doDeactivate = async () => {
    setBusy(true);
    try {
      await api.delete(`/workspaces/${id}`);
      router.push('/dashboard');
    } catch {
      setError('Не удалось деактивировать');
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
    <div>
      {error && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
          <span className="label-md" style={{ color: 'var(--primary)' }}>{error}</span>
        </div>
      )}
      {success && (
        <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
          <span className="label-md">{success}</span>
        </div>
      )}

      {/* ---------- Карточка ---------- */}
      {section === 'card' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)', flexWrap: 'wrap' }}>
            <h1 className="title-lg">Карточка компании</h1>
            {canManage && (
              <select
                value={asMember ? 'member' : 'owner'}
                onChange={(e) => setAsMember(e.target.value === 'member')}
                className="input"
                style={{ width: '210px' }}
              >
                <option value="owner">Как видите вы</option>
                <option value="member">Как видят сотрудники</option>
              </select>
            )}
          </div>
          <CompanyCard ws={previewWs} />
        </div>
      )}

      {/* ---------- Анкета ---------- */}
      {section === 'anketa' && canManage && (
        <div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Анкета компании</h1>
          <div className="card" style={{ display: 'grid', gap: 'var(--spacing-4)', maxWidth: '560px' }}>
            <Field label="Название" value={form.name} onChange={(v) => setForm({ ...form, name: v })} max={100} />
            <Field label="Логотип (ссылка)" value={form.logo} onChange={(v) => setForm({ ...form, logo: v })} max={500} placeholder="https://…" />
            <Field label="О компании" value={form.description} onChange={(v) => setForm({ ...form, description: v })} max={1000} textarea />
            <Field label="Отрасль" value={form.industry} onChange={(v) => setForm({ ...form, industry: v })} max={100} />
            <Field label="Город" value={form.city} onChange={(v) => setForm({ ...form, city: v })} max={100} />
            <Field label="Сайт" value={form.website} onChange={(v) => setForm({ ...form, website: v })} max={200} placeholder="https://…" />
            <Field label="Email" value={form.contactEmail} onChange={(v) => setForm({ ...form, contactEmail: v })} max={200} />
            <Field label="Телефон" value={form.contactPhone} onChange={(v) => setForm({ ...form, contactPhone: v })} max={20} />
            <button onClick={saveAnketa} disabled={saving} className="btn-primary" style={{ padding: '0.5rem 1.25rem', justifySelf: 'start' }}>
              {saving ? 'Сохраняем…' : 'Сохранить анкету'}
            </button>
          </div>

          <h2 className="title-md" style={{ margin: 'var(--spacing-8) 0 var(--spacing-3)' }}>Видимость для сотрудников</h2>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7 }}>
            Что сотрудники видят в карточке компании. Название и логотип видны всегда.
          </p>
          <div className="card" style={{ display: 'grid', gap: 'var(--spacing-1)', maxWidth: '560px' }}>
            {VIS_FIELDS.map((f) => (
              <VisRow key={f.key} label={f.label} on={!!vis[f.key]} onToggle={(v) => toggleVis(f.key, v)} />
            ))}
          </div>
        </div>
      )}

      {/* ---------- Статистика ---------- */}
      {section === 'stats' && (
        <div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Статистика</h1>
          <div className="grid grid-cols-2 md:grid-cols-3" style={{ gap: 'var(--spacing-6)' }}>
            <StatTile label="Сотрудников" value={ws.membersCount} />
            <StatTile label="Задач" value={ws.tasksCount ?? 0} />
            <StatTile
              label="Создана"
              value={new Date(ws.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
            />
          </div>
        </div>
      )}

      {/* ---------- Подписка ---------- */}
      {section === 'subscription' && (
        <div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Подписка</h1>
          <div className="wash-secondary" style={{ padding: 'var(--spacing-6)', maxWidth: '560px' }}>
            <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>Текущий план организации</div>
            <span className="title-md">Бесплатный</span>
            <p className="label-md" style={{ marginTop: 'var(--spacing-3)', fontSize: '0.85rem' }}>
              Платные планы для организаций появятся позже.
            </p>
            <button className="btn-primary" disabled style={{ marginTop: 'var(--spacing-4)', opacity: 0.5, cursor: 'not-allowed' }}>
              Улучшить (скоро)
            </button>
          </div>
        </div>
      )}

      {/* ---------- Настройки ---------- */}
      {section === 'settings' && canManage && (
        <div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Настройки</h1>
          <div className="card" style={{ display: 'grid', gap: 'var(--spacing-3)', maxWidth: '560px' }}>
            <div>
              <label className="label-sm">Часовой пояс</label>
              <input className="input" value="Asia/Almaty" disabled style={{ marginTop: 'var(--spacing-1)', width: '100%', opacity: 0.6 }} />
            </div>
            <p className="label-sm" style={{ opacity: 0.6 }}>Дополнительные настройки организации появятся позже.</p>
          </div>
        </div>
      )}

      {/* ---------- Безопасность ---------- */}
      {section === 'security' && isOwner && (
        <div>
          <h1 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>Безопасность</h1>

          <div className="card" style={{ maxWidth: '560px', marginBottom: 'var(--spacing-6)' }}>
            <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Передать владение</h2>
            <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7 }}>
              Новый владелец получит полные права, вы станете администратором.
            </p>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '220px' }}>
                <EntitySelector
                  types={['user']}
                  options={members.filter((m) => m.role !== 'owner').map((m) => ({ type: 'user', id: m.userId, title: m.userName, firstName: m.userName }))}
                  value={transferTo ? [{ type: 'user', id: transferTo }] : []}
                  onChange={(next) => setTransferTo(next[next.length - 1]?.id ?? '')}
                  placeholder="Выберите сотрудника…"
                />
              </div>
              <button onClick={() => setConfirm('transfer')} disabled={!transferTo || busy} className="btn-secondary" style={{ padding: '0.5rem 1.25rem' }}>
                Передать
              </button>
            </div>
          </div>

          <div className="card" style={{ maxWidth: '560px' }}>
            <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)', color: 'var(--danger)' }}>Опасная зона</h2>
            <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.7 }}>
              Деактивация скроет организацию. Данные сохраняются.
            </p>
            <button onClick={() => setConfirm('deactivate')} disabled={busy} className="btn-secondary" style={{ padding: '0.5rem 1.25rem', color: 'var(--danger)' }}>
              Деактивировать организацию
            </button>
          </div>

          {confirm && (
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(56,57,45,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 'var(--spacing-4)' }}
              onClick={() => !busy && setConfirm(null)}
            >
              <div className="card-elevated" style={{ maxWidth: '420px', padding: 'var(--spacing-6)' }} onClick={(e) => e.stopPropagation()}>
                <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>
                  {confirm === 'transfer' ? 'Передать владение?' : 'Деактивировать организацию?'}
                </h3>
                <p className="label-md" style={{ marginBottom: 'var(--spacing-5)', fontSize: '0.88rem' }}>
                  {confirm === 'transfer'
                    ? 'Вы передадите права владельца другому сотруднику. Это действие нельзя отменить самостоятельно.'
                    : 'Организация будет скрыта. Вернуть её можно будет только обращением в поддержку.'}
                </p>
                <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
                  <button onClick={() => setConfirm(null)} disabled={busy} className="btn-secondary" style={{ padding: '0.45rem 1.1rem' }}>Отмена</button>
                  <button
                    onClick={confirm === 'transfer' ? doTransfer : doDeactivate}
                    disabled={busy}
                    className="btn-primary"
                    style={{ padding: '0.45rem 1.1rem' }}
                  >
                    {busy ? '…' : 'Подтвердить'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  max,
  placeholder,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
  placeholder?: string;
  textarea?: boolean;
}) {
  return (
    <div>
      <label className="label-sm">{label}</label>
      {textarea ? (
        <textarea
          className="input"
          value={value}
          maxLength={max}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          style={{ marginTop: 'var(--spacing-1)', width: '100%', resize: 'vertical' }}
        />
      ) : (
        <input
          className="input"
          value={value}
          maxLength={max}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{ marginTop: 'var(--spacing-1)', width: '100%' }}
        />
      )}
    </div>
  );
}

function VisRow({ label, on, onToggle }: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--spacing-2) 0' }}>
      <span className="label-md" style={{ fontSize: '0.88rem' }}>{label}</span>
      <button
        onClick={() => onToggle(!on)}
        style={{
          padding: '0.25rem 0.8rem',
          borderRadius: 'var(--radius-sm)',
          border: 'none',
          cursor: 'pointer',
          fontSize: '0.75rem',
          fontWeight: 600,
          background: on ? 'var(--secondary-container)' : 'var(--surface-container)',
          color: on ? 'var(--secondary)' : 'var(--on-surface-variant)',
        }}
      >
        {on ? 'Видно' : 'Скрыто'}
      </button>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div className="display-md" style={{ color: 'var(--primary)', fontSize: '2rem' }}>{value}</div>
      <div className="label-md" style={{ marginTop: 'var(--spacing-1)' }}>{label}</div>
    </div>
  );
}
