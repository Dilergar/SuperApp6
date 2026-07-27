'use client';

import { useState, useEffect, useCallback } from 'react';
import { api, apiErrorMessage } from '@/lib/api';
import { Alert, Button, Card, Chip, Field, Icon, Modal } from '@/components/ui';
import type { GoogleConnectionStatus, GoogleCalendarListItem, GoogleSyncResult } from '@superapp/shared';

export function GooglePanel({ onClose }: { onClose: (changed: boolean) => void }) {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendarListItem[] | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try { setStatus((await api.get('/integrations/google/status')).data.data); } catch { /* окно откроется как «не подключено» */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await api.get('/integrations/google/auth-url');
      window.location.href = data.data.url; // redirect to Google consent
    } catch (e) {
      const a = e as { response?: { status?: number } };
      if (a.response?.status === 400) setNotConfigured(true);
      else setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const loadCalendars = async () => {
    try {
      setCalendars((await api.get('/integrations/google/calendars')).data.data);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const selectCalendar = async (calendarId: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      await api.post('/integrations/google/select-calendar', { calendarId });
      setChanged(true);
      await load();
      setMsg('Календарь выбран, синхронизация запущена');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const { data } = await api.post('/integrations/google/sync');
      const r: GoogleSyncResult = data.data;
      setChanged(true);
      await load();
      setMsg(`Готово: выгружено ${r.pushed}, загружено ${r.pulled}, удалено ${r.deleted}`);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      await api.delete('/integrations/google');
      setChanged(true);
      await load();
      setCalendars(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  const connected = status?.connected;

  return (
    <Modal
      open
      onClose={() => onClose(changed)}
      title="Google Календарь"
      subtitle={connected ? undefined : 'Двусторонняя синхронизация: события из SuperApp6 появятся в Google и наоборот'}
      size="sm"
      footer={
        connected ? (
          <>
            <Button variant="ghost" tone="danger" icon="plug" disabled={busy} onClick={disconnect}>Отключить</Button>
            <Button variant="ghost" onClick={() => onClose(changed)}>Закрыть</Button>
            <Button variant="primary" icon="refresh" loading={busy} onClick={syncNow}>Синхронизировать</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onClose(changed)}>Закрыть</Button>
            {!notConfigured && (
              <Button variant="primary" icon="link" loading={busy} onClick={connect}>Подключить Google</Button>
            )}
          </>
        )
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
        {msg && <Alert tone="success" onClose={() => setMsg('')}>{msg}</Alert>}

        {notConfigured ? (
          <Alert tone="warning" icon="plug" title="Интеграция ещё не настроена">
            В <code>.env</code> сервера нет OAuth-данных Google (<code>GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI</code>).
            Зарегистрируйте OAuth-приложение в Google Cloud и добавьте их — тогда появится кнопка подключения.
          </Alert>
        ) : !connected ? (
          <p className="body-md" style={{ margin: 0 }}>
            Задачи выгружаются в отдельный календарь — в Google они только для чтения.
          </p>
        ) : (
          <>
            <Card small>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Icon name="checkCircle" size={17} style={{ color: 'var(--success)' }} />
                <span className="title-sm">{status?.email}</span>
              </div>
              <div className="label-sm" style={{ marginTop: '0.375rem' }}>
                Календарь: <strong>{status?.syncCalendarName ?? '—'}</strong>
              </div>
              <div className="label-sm">
                Синхронизация: {status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString('ru-RU') : 'ещё не было'}
              </div>
            </Card>

            <Field label="Календарь для синхры">
              {calendars === null ? (
                <Button variant="matte" size="sm" icon="calendar" onClick={loadCalendars}>Сменить календарь…</Button>
              ) : (
                <div style={{ display: 'grid', gap: '0.25rem' }}>
                  <CalendarRow
                    label="Создать отдельный «SuperApp6»"
                    icon="calendarAdd"
                    active={false}
                    disabled={busy}
                    onClick={() => selectCalendar('__new__')}
                  />
                  {calendars.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer').map((c) => (
                    <CalendarRow
                      key={c.id}
                      label={c.summary}
                      icon="calendar"
                      hint={c.primary ? 'основной' : undefined}
                      active={c.id === status?.syncCalendarId}
                      disabled={busy}
                      onClick={() => selectCalendar(c.id)}
                    />
                  ))}
                </div>
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Строка выбора календаря Google — тот же вид, что у пунктов выпадающих списков кита. */
function CalendarRow({
  label, icon, hint, active, disabled, onClick,
}: {
  label: string;
  icon: 'calendar' | 'calendarAdd';
  hint?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', textAlign: 'left',
        padding: '0.4375rem 0.625rem', borderRadius: 'var(--radius-md)', cursor: disabled ? 'default' : 'pointer',
        background: active ? 'var(--secondary-container)' : 'transparent',
        border: `1px solid ${active ? 'var(--primary)' : 'var(--divider)'}`,
        color: 'var(--on-surface)',
      }}
    >
      <Icon name={icon} size={16} style={{ color: 'var(--muted)' }} />
      <span className="title-sm" style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {hint && <Chip size="sm" tone="neutral">{hint}</Chip>}
      {active && <Icon name="check" size={15} style={{ color: 'var(--primary-dim)' }} />}
    </button>
  );
}
