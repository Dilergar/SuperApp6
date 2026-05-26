'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  CALENDAR_ACCESS_LEVEL_META,
  SMART_MATCH_DEFAULTS,
  SMART_MATCH_DURATIONS,
  type Contact,
  type CalendarShare,
  type SharedCalendarSource,
  type SmartMatchSlot,
} from '@superapp/shared';

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)', overflowY: 'auto' };
const card: React.CSSProperties = { width: '100%', maxWidth: 520, padding: 'var(--spacing-6)' };
const lbl: React.CSSProperties = { display: 'block', marginBottom: 'var(--spacing-2)' };
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--on-surface-variant)' };

function chip(active: boolean): React.CSSProperties {
  return { padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: 'var(--radius-sketch)', border: 'none', cursor: 'pointer', fontWeight: 600, background: active ? 'var(--secondary-container)' : 'var(--surface-container)', color: active ? 'var(--secondary)' : 'var(--on-surface-variant)' };
}

// ============================================================
// Share panel — manage who can see my calendar (per person)
// ============================================================

export function SharePanel({ contacts, onClose }: { contacts: Contact[]; onClose: (changed: boolean) => void }) {
  const [shares, setShares] = useState<CalendarShare[]>([]);
  const [changed, setChanged] = useState(false);
  const [pickId, setPickId] = useState<string>('');
  const [level, setLevel] = useState<'busy' | 'detailed'>('busy');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setShares((await api.get('/calendar/shares')).data.data); } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!pickId) return;
    setBusy(true);
    try {
      await api.post('/calendar/shares', { sharedWithUserId: pickId, accessLevel: level });
      setChanged(true); setPickId('');
      await load();
    } catch { /* ignore */ } finally { setBusy(false); }
  };
  const remove = async (uid: string) => {
    setBusy(true);
    try { await api.delete(`/calendar/shares/${uid}`); setChanged(true); await load(); } catch { /* ignore */ } finally { setBusy(false); }
  };

  const available = contacts.filter((c) => !shares.some((s) => s.sharedWithUserId === c.them.id));

  return (
    <div onClick={() => onClose(changed)} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
          <h3 className="title-md">Доступ к моему календарю</h3>
          <button onClick={() => onClose(changed)} style={closeBtn}>✕</button>
        </div>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>
          По умолчанию календарь приватный. Здесь — персональный доступ; по Группам — в настройках Группы на «Моё окружение».
        </p>

        {/* add */}
        <label className="label-md" style={lbl}>Открыть человеку</label>
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-2)' }}>
          <select className="input-sketch" value={pickId} onChange={(e) => setPickId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
            <option value="">— выбрать —</option>
            {available.map((c) => <option key={c.them.id} value={c.them.id}>{c.them.firstName} {c.them.lastName ?? ''}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
            {(['busy', 'detailed'] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLevel(l)} style={chip(level === l)}>{CALENDAR_ACCESS_LEVEL_META[l].label}</button>
            ))}
          </div>
          <button onClick={add} disabled={!pickId || busy} className="btn-primary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem', opacity: !pickId || busy ? 0.6 : 1 }}>Дать доступ</button>
        </div>

        {/* current */}
        <div style={{ marginTop: 'var(--spacing-4)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {shares.length === 0 ? <p className="label-sm">Пока никому не открыт</p> : shares.map((s) => (
            <div key={s.sharedWithUserId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.6rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{s.firstName} {s.lastName ?? ''}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <span className="label-sm" style={{ color: 'var(--secondary)' }}>{CALENDAR_ACCESS_LEVEL_META[s.accessLevel].label}</span>
                <button onClick={() => remove(s.sharedWithUserId)} style={closeBtn} title="Закрыть доступ">✕</button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Smart Match — find common free time with people who shared with me
// ============================================================

export function SmartMatchDialog({
  sources, onClose, onPick,
}: {
  sources: SharedCalendarSource[];
  onClose: () => void;
  onPick: (start: string, userIds: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [duration, setDuration] = useState(60);
  const [days, setDays] = useState(7);
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(21);
  const [slots, setSlots] = useState<SmartMatchSlot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = async () => {
    if (!sel.length) { setError('Выберите хотя бы одного человека'); return; }
    setBusy(true); setError('');
    const now = new Date();
    const from = new Date(now.getTime() + 5 * 60_000); // a few minutes ahead
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59);
    // convert local working hours -> UTC minutes-from-midnight (KZ has no DST)
    const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate(), fromHour, 0);
    const ref2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), toHour, 0);
    const dayStartMin = ref.getUTCHours() * 60 + ref.getUTCMinutes();
    const dayEndMin = ref2.getUTCHours() * 60 + ref2.getUTCMinutes();
    try {
      const { data } = await api.post('/calendar/smart-match', {
        userIds: sel, durationMin: duration, from: from.toISOString(), to: to.toISOString(),
        dayStartMin, dayEndMin: dayEndMin > dayStartMin ? dayEndMin : dayStartMin + 720,
      });
      setSlots(data.data.slots);
    } catch (e: unknown) {
      const a = e as { response?: { data?: { message?: string } } };
      setError(a.response?.data?.message || 'Не удалось подобрать время');
    } finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-2)' }}>
          <h3 className="title-md">Подобрать общее время</h3>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>Среди тех, кто открыл тебе календарь. Чужая занятость не раскрывается — только свободные окна.</p>

        {sources.length === 0 ? (
          <p className="label-md">Пока никто не открыл тебе свой календарь — некого подбирать.</p>
        ) : (
          <>
            <label className="label-md" style={lbl}>С кем</label>
            <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
              {sources.map((s) => {
                const on = sel.includes(s.userId);
                return <button key={s.userId} onClick={() => setSel((c) => on ? c.filter((x) => x !== s.userId) : [...c, s.userId])} style={chip(on)}>{s.firstName} {s.lastName ?? ''}</button>;
              })}
            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-4)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
              <div>
                <label className="label-md" style={lbl}>Длительность</label>
                <div style={{ display: 'flex', gap: 'var(--spacing-1)', flexWrap: 'wrap' }}>
                  {SMART_MATCH_DURATIONS.map((d) => <button key={d.min} onClick={() => setDuration(d.min)} style={chip(duration === d.min)}>{d.label}</button>)}
                </div>
              </div>
              <div>
                <label className="label-md" style={lbl}>Период</label>
                <div style={{ display: 'flex', gap: 'var(--spacing-1)' }}>
                  {[7, 14, 30].map((d) => <button key={d} onClick={() => setDays(d)} style={chip(days === d)}>{d} дн.</button>)}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', marginBottom: 'var(--spacing-4)' }}>
              <label className="label-md">Часы</label>
              <input type="number" min={0} max={23} value={fromHour} onChange={(e) => setFromHour(Math.min(23, Math.max(0, +e.target.value)))} className="input-sketch" style={{ width: 64 }} />
              <span>—</span>
              <input type="number" min={1} max={24} value={toHour} onChange={(e) => setToHour(Math.min(24, Math.max(1, +e.target.value)))} className="input-sketch" style={{ width: 64 }} />
            </div>

            {error && <p className="label-sm" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-3)' }}>{error}</p>}

            <button onClick={search} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem', padding: '0.5rem 1.3rem', marginBottom: 'var(--spacing-4)' }}>{busy ? 'Ищу…' : 'Найти окна'}</button>

            {slots && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
                {slots.length === 0 ? <p className="label-sm">Свободных окон не нашлось — попробуй другой период или часы.</p> : slots.slice(0, 20).map((s) => (
                  <button key={s.start} onClick={() => onPick(s.start, sel)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-container-low)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.7rem', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{slotLabel(s.start)}</span>
                    <span className="label-sm" style={{ color: 'var(--secondary)' }}>выбрать →</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function slotLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
