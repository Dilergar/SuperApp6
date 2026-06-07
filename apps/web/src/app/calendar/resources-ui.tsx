'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip } from '../circles/PersonCard';
import {
  RESOURCE_TYPE_META,
  RESOURCE_BOOKING_STATUS_META,
  type Resource,
  type ResourceBooking,
  type ResourceType,
  type Contact,
  type Circle,
} from '@superapp/shared';

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)', overflowY: 'auto' };
const lbl: React.CSSProperties = { display: 'block', marginBottom: 'var(--spacing-2)' };
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--on-surface-variant)' };
const smallBtn: React.CSSProperties = { padding: '0.4rem 1rem', fontSize: '0.8rem' };

function chip(active: boolean): React.CSSProperties {
  return { padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)', border: 'none', cursor: 'pointer', fontWeight: 600, background: active ? 'var(--secondary-container)' : 'var(--surface-container)', color: active ? 'var(--secondary)' : 'var(--on-surface-variant)' };
}

export function ResourcesPanel({
  contacts, circles, onClose,
}: {
  contacts: Contact[];
  circles: Circle[];
  onClose: (changed: boolean) => void;
}) {
  const [list, setList] = useState<Resource[]>([]);
  const [requests, setRequests] = useState<ResourceBooking[]>([]);
  const [changed, setChanged] = useState(false);
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setList((await api.get('/resources')).data.data); } catch { /* ignore */ }
    try { setRequests((await api.get('/resources/requests')).data.data); } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mine = list.filter((r) => r.isOwner);

  const act = async (eventId: string, action: 'confirm' | 'reject') => {
    setBusy(true);
    try { await api.post(`/resources/bookings/${eventId}/${action}`); setChanged(true); await load(); } catch { /* ignore */ } finally { setBusy(false); }
  };
  const del = async (id: string) => {
    setBusy(true);
    try { await api.delete(`/resources/${id}`); setChanged(true); await load(); } catch { /* ignore */ } finally { setBusy(false); }
  };

  return (
    <div onClick={() => onClose(changed)} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ width: '100%', maxWidth: 600, padding: 'var(--spacing-6)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
          <h3 className="title-md">Ресурсы</h3>
          <button onClick={() => onClose(changed)} style={closeBtn}>✕</button>
        </div>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          Общие вещи (переговорка, машина, оборудование) со своим расписанием. Бронируешь, прикрепляя ресурс к событию.
        </p>

        {/* Incoming requests */}
        {requests.length > 0 && (
          <div className="wash-secondary" style={{ padding: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
            <div className="title-md" style={{ fontSize: '0.9rem', marginBottom: 'var(--spacing-2)' }}>Заявки на бронь ({requests.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
              {requests.map((r) => (
                <div key={r.eventId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{r.resourceName}: {r.title}</div>
                    <div className="label-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                      <PersonChip size="S" userId={r.bookerId} firstName={r.bookerName} />
                      <span>· {slot(r.start)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexShrink: 0 }}>
                    <button onClick={() => act(r.eventId, 'confirm')} disabled={busy} className="btn-primary" style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem' }}>✓</button>
                    <button onClick={() => act(r.eventId, 'reject')} disabled={busy} style={{ ...chip(false), color: 'var(--primary)' }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* My resources */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-2)' }}>
          <label className="label-md">Мои ресурсы</label>
          {editing === null && <button onClick={() => setEditing('new')} style={chip(false)}>+ Создать</button>}
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
          <p className="label-sm">Пока нет ресурсов</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {mine.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.7rem' }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{RESOURCE_TYPE_META[r.type].icon} {r.name}</span>
                  <span className="label-sm" style={{ marginLeft: 'var(--spacing-2)' }}>вмест. {r.capacity} · доступ: {r.bookerUserIds.length + r.bookerCircleIds.length || '—'}</span>
                </div>
                <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
                  <button onClick={() => setEditing(r)} style={chip(false)}>✎</button>
                  <button onClick={() => del(r.id)} disabled={busy} style={{ ...chip(false), color: 'var(--primary)' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
  const [name, setName] = useState(resource?.name ?? '');
  const [type, setType] = useState<ResourceType>(resource?.type ?? 'room');
  const [capacity, setCapacity] = useState(resource?.capacity ?? 1);
  const [userIds, setUserIds] = useState<string[]>(resource?.bookerUserIds ?? []);
  const [circleIds, setCircleIds] = useState<string[]>(resource?.bookerCircleIds ?? []);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const payload = { name: name.trim(), type, capacity, bookerUserIds: userIds, bookerCircleIds: circleIds };
    try {
      if (resource) await api.patch(`/resources/${resource.id}`, payload);
      else await api.post('/resources', payload);
      onSaved();
    } catch { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 'var(--spacing-4)', marginBottom: 'var(--spacing-3)' }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (напр. Переговорка)" className="input-sketch" style={{ marginBottom: 'var(--spacing-3)', fontWeight: 600 }} autoFocus />
      <div style={{ display: 'flex', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-3)' }}>
        <div>
          <label className="label-sm" style={lbl}>Тип</label>
          <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap' }}>
            {(Object.keys(RESOURCE_TYPE_META) as ResourceType[]).map((t) => (
              <button key={t} type="button" onClick={() => setType(t)} style={chip(type === t)}>{RESOURCE_TYPE_META[t].icon} {RESOURCE_TYPE_META[t].label}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label-sm" style={lbl}>Вместимость</label>
          <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 1))} className="input-sketch" style={{ width: 80 }} />
        </div>
      </div>

      <label className="label-sm" style={lbl}>Кто может бронировать</label>
      <div style={{ marginBottom: 'var(--spacing-3)' }}>
        <EntitySelector
          types={['user', 'circle']}
          multi
          options={[
            ...contacts.map((c) => ({ type: 'user', id: c.them.id, title: `${c.them.firstName} ${c.them.lastName ?? ''}`.trim(), firstName: c.them.firstName, lastName: c.them.lastName, role: c.myRole })),
            ...circles.map((g) => ({ type: 'circle', id: g.id, title: g.name, icon: g.icon, color: g.color, count: g.membersCount })),
          ]}
          value={[...userIds.map((id) => ({ type: 'user', id })), ...circleIds.map((id) => ({ type: 'circle', id }))]}
          onChange={(next) => { setUserIds(next.filter((p) => p.type === 'user').map((p) => p.id)); setCircleIds(next.filter((p) => p.type === 'circle').map((p) => p.id)); }}
          placeholder="Люди или Группы…"
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
        <button onClick={onCancel} className="btn-secondary" style={smallBtn}>Отмена</button>
        <button onClick={save} disabled={busy || !name.trim()} className="btn-primary" style={{ ...smallBtn, opacity: busy || !name.trim() ? 0.6 : 1 }}>{resource ? 'Сохранить' : 'Создать'}</button>
      </div>
    </div>
  );
}

function slot(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
