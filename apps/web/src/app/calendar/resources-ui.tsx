'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { Formatters } from '@superapp/i18n/format';
import { useFormatters } from '@/lib/format';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import {
  Alert, Button, Card, Chip, Divider, EmptyState, Field, IconButton, Input, Modal,
  type IconName,
} from '@/components/ui';
import {
  RESOURCE_TYPE_META,
  type Resource,
  type ResourceBooking,
  type ResourceType,
  type Contact,
  type Circle,
} from '@superapp/shared';

/**
 * Интерфейсная иконка типа ресурса. В shared у типа лежит эмодзи, но здесь это
 * НЕ данные человека, а элемент интерфейса — значит рисуем иконкой кита
 * (DESIGN.md §3), а эмодзи из константы не печатаем.
 */
const RESOURCE_TYPE_ICON: Record<ResourceType, IconName> = {
  room: 'workspace',
  vehicle: 'device',
  equipment: 'plug',
  other: 'folder',
};

export function ResourcesPanel({
  contacts, circles, onClose,
}: {
  contacts: Contact[];
  circles: Circle[];
  onClose: (changed: boolean) => void;
}) {
  const t = useTranslations('calendar');
  const tc = useTranslations('common');
  const f = useFormatters();
  const [list, setList] = useState<Resource[]>([]);
  const [requests, setRequests] = useState<ResourceBooking[]>([]);
  const [changed, setChanged] = useState(false);
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setList(await apiGet('/resources')); } catch { /* тихо: панель откроется пустой */ }
    try { setRequests(await apiGet('/resources/requests')); } catch { /* заявок может не быть */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mine = list.filter((r) => r.isOwner);

  const act = async (eventId: string, action: 'confirm' | 'reject') => {
    setBusy(true);
    try {
      await apiPost(`/resources/bookings/${eventId}/${action}`);
      setChanged(true);
      await load();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };
  const del = async (id: string) => {
    setBusy(true);
    try {
      await apiDelete(`/resources/${id}`);
      setChanged(true);
      await load();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={() => onClose(changed)}
      title={t('resources.title')}
      subtitle={t('resources.subtitle')}
      size="lg"
      footer={<Button variant="ghost" onClick={() => onClose(changed)}>{tc('actions.ready')}</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}

        {/* Заявки на бронь моих ресурсов */}
        {requests.length > 0 && (
          <Field label={t('resources.requests', { n: requests.length })}>
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {requests.map((r) => (
                <div
                  key={r.eventId}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                    flexWrap: 'wrap', border: '1px solid var(--warning-border)', background: 'var(--warning-container)',
                    borderRadius: 'var(--radius-md)', padding: '0.5rem 0.625rem',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="title-sm">{r.resourceName}: {r.title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                      <PersonChip size="S" userId={r.bookerId} firstName={r.bookerName} />
                      <span className="label-sm">{slot(r.start, f)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.375rem', flex: 'none' }}>
                    <Button variant="primary" tone="success" size="sm" icon="check" disabled={busy} onClick={() => act(r.eventId, 'confirm')}>
                      {t('modal.confirm')}
                    </Button>
                    <Button variant="matte" tone="danger" size="sm" icon="close" disabled={busy} onClick={() => act(r.eventId, 'reject')}>
                      {t('modal.reject')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Field>
        )}

        {requests.length > 0 && <Divider style={{ margin: 0 }} />}

        {/* Мои ресурсы */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)' }}>
          <span className="label-caps">{t('resources.mine')}</span>
          {editing === null && (
            <Button variant="matte" tone="accent" size="sm" icon="add" onClick={() => setEditing('new')}>{t('resources.create')}</Button>
          )}
        </div>

        {editing && (
          <ResourceForm
            resource={editing === 'new' ? null : editing}
            contacts={contacts}
            circles={circles}
            onCancel={() => setEditing(null)}
            onSaved={async () => { setEditing(null); setChanged(true); await load(); }}
          />
        )}

        {mine.length === 0 && !editing ? (
          <EmptyState
            icon="folder"
            title={t('resources.emptyTitle')}
            description={t('resources.emptyHint')}
            action={<Button variant="matte" icon="add" onClick={() => setEditing('new')}>{t('resources.createOne')}</Button>}
          />
        ) : (
          <div className="ui-stack" style={{ gap: '0.375rem' }}>
            {mine.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                  flexWrap: 'wrap', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
                  padding: '0.5rem 0.625rem',
                }}
              >
                <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Chip size="sm" tone="neutral" icon={RESOURCE_TYPE_ICON[r.type]}>
                    {t(`resourceType.${r.type}`)}
                  </Chip>
                  <span className="title-sm">{r.name}</span>
                  <span className="label-sm">
                    {t('resources.capacityLine', { capacity: r.capacity, access: r.bookerUserIds.length + r.bookerCircleIds.length || '—' })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  <IconButton icon="edit" label={t('resources.edit', { name: r.name })} size={30} onClick={() => setEditing(r)} />
                  <IconButton icon="delete" label={t('resources.delete', { name: r.name })} size={30} disabled={busy} onClick={() => del(r.id)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ResourceForm({
  resource, contacts, circles, onCancel, onSaved,
}: {
  resource: Resource | null;
  contacts: Contact[];
  circles: Circle[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('calendar');
  const tc = useTranslations('common');
  const [name, setName] = useState(resource?.name ?? '');
  const [type, setType] = useState<ResourceType>(resource?.type ?? 'room');
  const [capacity, setCapacity] = useState(resource?.capacity ?? 1);
  const [userIds, setUserIds] = useState<string[]>(resource?.bookerUserIds ?? []);
  const [circleIds, setCircleIds] = useState<string[]>(resource?.bookerCircleIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    const payload = { name: name.trim(), type, capacity, bookerUserIds: userIds, bookerCircleIds: circleIds };
    try {
      if (resource) await apiPatch(`/resources/${resource.id}`, payload);
      else await apiPost('/resources', payload);
      onSaved();
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Card small>
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}

        <Input label={t('resources.name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('resources.namePlaceholder')} autoFocus />

        <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
          <Field label={t('resources.type')}>
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              {(Object.keys(RESOURCE_TYPE_META) as ResourceType[]).map((rt) => (
                <Chip
                  key={rt}
                  size="sm"
                  tone="accent"
                  icon={RESOURCE_TYPE_ICON[rt]}
                  selected={type === rt}
                  onClick={() => setType(rt)}
                >
                  {t(`resourceType.${rt}`)}
                </Chip>
              ))}
            </div>
          </Field>
          <div style={{ width: 110 }}>
            <Input
              label={t('resources.capacity')}
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        </div>

        <Field label={t('resources.whoCanBook')} hint={t('resources.whoCanBookHint')}>
          <EntitySelector
            types={['user', 'circle']}
            multi
            options={[
              ...contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole })),
              ...circles.map((g) => ({ type: 'circle', id: g.id, title: g.name, icon: g.icon, color: g.color, count: g.membersCount })),
            ]}
            value={[...userIds.map((id) => ({ type: 'user', id })), ...circleIds.map((id) => ({ type: 'circle', id }))]}
            onChange={(next) => {
              setUserIds(next.filter((p) => p.type === 'user').map((p) => p.id));
              setCircleIds(next.filter((p) => p.type === 'circle').map((p) => p.id));
            }}
            placeholder={t('resources.pickPlaceholder')}
          />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>{tc('actions.cancel')}</Button>
          <Button
            variant="primary"
            tone="success"
            size="sm"
            icon={resource ? 'save' : 'add'}
            disabled={!name.trim()}
            loading={busy}
            onClick={save}
          >
            {resource ? tc('actions.save') : tc('actions.create')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** «3 сентября, 14:35» — правила региона, слова языка зрителя. */
function slot(iso: string, f: Formatters): string {
  return f.dateTime(iso, 'dayMonthLong');
}
