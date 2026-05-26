'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { GoogleConnectionStatus, GoogleCalendarListItem, GoogleSyncResult } from '@superapp/shared';

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 1rem', background: 'rgba(56,57,45,0.28)', backdropFilter: 'blur(3px)', overflowY: 'auto' };
const closeBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--on-surface-variant)' };
const lbl: React.CSSProperties = { display: 'block', marginBottom: 'var(--spacing-2)' };

export function GooglePanel({ onClose }: { onClose: (changed: boolean) => void }) {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendarListItem[] | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try { setStatus((await api.get('/integrations/google/status')).data.data); } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy(true); setMsg('');
    try {
      const { data } = await api.get('/integrations/google/auth-url');
      window.location.href = data.data.url; // redirect to Google consent
    } catch (e: unknown) {
      const a = e as { response?: { status?: number } };
      if (a.response?.status === 400) setNotConfigured(true);
      else setMsg('Не удалось начать подключение');
      setBusy(false);
    }
  };

  const loadCalendars = async () => {
    try { setCalendars((await api.get('/integrations/google/calendars')).data.data); } catch { setMsg('Не удалось получить список календарей'); }
  };

  const selectCalendar = async (calendarId: string) => {
    setBusy(true); setMsg('');
    try {
      await api.post('/integrations/google/select-calendar', { calendarId });
      setChanged(true);
      await load();
      setMsg('Календарь выбран, синхронизация запущена');
    } catch { setMsg('Не удалось выбрать календарь'); } finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setMsg('');
    try {
      const { data } = await api.post('/integrations/google/sync');
      const r: GoogleSyncResult = data.data;
      setChanged(true);
      await load();
      setMsg(`Готово: ↑${r.pushed} ↓${r.pulled} 🗑${r.deleted}`);
    } catch { setMsg('Синхронизация не удалась'); } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setMsg('');
    try { await api.delete('/integrations/google'); setChanged(true); await load(); setCalendars(null); } catch { setMsg('Не удалось отключить'); } finally { setBusy(false); }
  };

  const connected = status?.connected;

  return (
    <div onClick={() => onClose(changed)} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} className="card-elevated" style={{ width: '100%', maxWidth: 480, padding: 'var(--spacing-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-3)' }}>
          <h3 className="title-md">Google Календарь</h3>
          <button onClick={() => onClose(changed)} style={closeBtn}>✕</button>
        </div>

        {notConfigured ? (
          <div className="wash-primary" style={{ padding: 'var(--spacing-3)', fontSize: '0.85rem' }}>
            Интеграция ещё не настроена: в <code>.env</code> сервера нет OAuth-данных Google (<code>GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI</code>). Зарегистрируй OAuth-приложение в Google Cloud и добавь их — тогда появится кнопка подключения.
          </div>
        ) : !connected ? (
          <>
            <p className="label-md" style={{ marginBottom: 'var(--spacing-4)' }}>
              Двусторонняя синхронизация: события из SuperApp6 появятся в Google и наоборот. Задачи выгружаются в отдельный календарь (только чтение в Google).
            </p>
            <button onClick={connect} disabled={busy} className="btn-primary" style={{ fontSize: '0.9rem', padding: '0.55rem 1.3rem' }}>
              {busy ? '…' : 'Подключить Google'}
            </button>
          </>
        ) : (
          <>
            <div className="card" style={{ padding: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>✅ {status?.email}</div>
              <div className="label-sm" style={{ marginTop: 4 }}>
                Календарь: <strong>{status?.syncCalendarName ?? '—'}</strong>
              </div>
              <div className="label-sm">
                Синхронизация: {status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString('ru-RU') : 'ещё не было'}
              </div>
            </div>

            <label className="label-md" style={lbl}>Календарь для синхры</label>
            {calendars === null ? (
              <button onClick={loadCalendars} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 1rem', marginBottom: 'var(--spacing-4)' }}>Сменить календарь…</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)', marginBottom: 'var(--spacing-4)' }}>
                <button onClick={() => selectCalendar('__new__')} disabled={busy} style={pickRow(false)}>➕ Создать отдельный «SuperApp6»</button>
                {calendars.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer').map((c) => (
                  <button key={c.id} onClick={() => selectCalendar(c.id)} disabled={busy} style={pickRow(c.id === status?.syncCalendarId)}>
                    {c.summary}{c.primary ? ' (основной)' : ''}
                  </button>
                ))}
              </div>
            )}

            {msg && <p className="label-sm" style={{ color: 'var(--secondary)', marginBottom: 'var(--spacing-3)' }}>{msg}</p>}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)' }}>
              <button onClick={disconnect} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontWeight: 700, fontSize: '0.85rem' }}>Отключить</button>
              <button onClick={syncNow} disabled={busy} className="btn-primary" style={{ fontSize: '0.85rem', padding: '0.5rem 1.3rem', opacity: busy ? 0.6 : 1 }}>{busy ? '…' : 'Синхронизировать сейчас'}</button>
            </div>
          </>
        )}
        {!connected && msg && <p className="label-sm" style={{ color: 'var(--primary)', marginTop: 'var(--spacing-3)' }}>{msg}</p>}
      </div>
    </div>
  );
}

function pickRow(active: boolean): React.CSSProperties {
  return {
    textAlign: 'left', padding: '0.45rem 0.7rem', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
    background: active ? 'var(--secondary-container)' : 'var(--surface-container-low)',
    color: active ? 'var(--secondary)' : 'var(--on-surface)', fontWeight: 600, fontSize: '0.82rem',
  };
}
