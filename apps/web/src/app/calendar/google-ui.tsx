'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import { apiDelete, apiErrorDetails, apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { ConsentDocumentView } from '@/components/consents/ConsentDocumentView';
import { fetchConsentDocument } from '@/lib/public-api';
import { Alert, Button, Card, Chip, Field, Icon, Modal } from '@/components/ui';
import { CONSENT_ERROR_CODES, type GoogleConnectionStatus, type GoogleCalendarListItem, type GoogleSyncResult, type Locale } from '@superapp/shared';

export function GooglePanel({ onClose }: { onClose: (changed: boolean) => void }) {
  const t = useTranslations('calendar');
  const tc = useTranslations('common');
  const shell = useTranslations('shell');
  const uiLocale = useLocale() as Locale;
  // Подключение Google — трансграничная передача: отдельное согласие В МОМЕНТ подключения (core/consents)
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentLocale, setConsentLocale] = useState<Locale>(uiLocale);
  const f = useFormatters();
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendarListItem[] | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await apiGet('/integrations/google/status')); } catch { /* окно откроется как «не подключено» */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy(true); setError('');
    try {
      const { url } = await apiGet<{ url: string }>('/integrations/google/auth-url');
      window.location.href = url; // redirect to Google consent
    } catch (e) {
      const a = e as { response?: { status?: number } };
      // Сервер просит согласие `integration_google` — показываем текст; «не настроено» — другой отказ
      if (apiErrorDetails(e)?.code === CONSENT_ERROR_CODES.required) setConsentOpen(true);
      else if (a.response?.status === 400) setNotConfigured(true);
      else setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const acceptAndConnect = async () => {
    setBusy(true); setError('');
    try {
      // Принимается версия, показанная на экране, на языке показа; затем подключение повторяется
      const doc = await fetchConsentDocument('integration_google', consentLocale);
      await apiPost('/consents/accept', { versionIds: [doc.versionId], locale: consentLocale, channel: 'web' });
      setConsentOpen(false);
      if (status?.connected) { await load(); setBusy(false); } else await connect();
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const loadCalendars = async () => {
    try {
      setCalendars(await apiGet('/integrations/google/calendars'));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const selectCalendar = async (calendarId: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      await apiPost('/integrations/google/select-calendar', { calendarId });
      setChanged(true);
      await load();
      setMsg(t('google.picked'));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await apiPost<GoogleSyncResult>('/integrations/google/sync');
      setChanged(true);
      await load();
      setMsg(t('google.syncDone', { pushed: r.pushed, pulled: r.pulled, deleted: r.deleted }));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      await apiDelete('/integrations/google');
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
      title={t('google.title')}
      subtitle={connected ? undefined : t('google.subtitle')}
      size="sm"
      footer={
        connected ? (
          <>
            <Button variant="ghost" tone="danger" icon="plug" disabled={busy} onClick={disconnect}>{t('google.disconnect')}</Button>
            <Button variant="ghost" onClick={() => onClose(changed)}>{tc('actions.close')}</Button>
            <Button variant="primary" icon="refresh" loading={busy} onClick={syncNow}>{t('google.syncNow')}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onClose(changed)}>{tc('actions.close')}</Button>
            {!notConfigured && (
              <Button variant="primary" icon="link" loading={busy} onClick={connect}>{t('google.connect')}</Button>
            )}
          </>
        )
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
        {msg && <Alert tone="success" onClose={() => setMsg('')}>{msg}</Alert>}
        {/* Подключение прошлой эпохи без согласия: синхронизация стоит, пока человек его не даст */}
        {connected && status?.consentRequired && (
          <Alert tone="warning" action={<Button size="sm" variant="matte" tone="warning" onClick={() => setConsentOpen(true)}>{shell('consents.banner.action')}</Button>}>
            {shell('consents.google.needed')}
          </Alert>
        )}
        {consentOpen && (
          <Modal
            open
            onClose={() => setConsentOpen(false)}
            size="lg"
            title={shell('consents.google.title')}
            footer={<Button variant="primary" loading={busy} onClick={acceptAndConnect}>{shell('consents.google.accept')}</Button>}
          >
            <ConsentDocumentView documentKey="integration_google" onLocaleChange={setConsentLocale} />
          </Modal>
        )}

        {notConfigured ? (
          <Alert tone="warning" icon="plug" title={t('google.notConfigured')}>
            {t('google.notConfiguredBody')}
          </Alert>
        ) : !connected ? (
          <p className="body-md" style={{ margin: 0 }}>
            {t('google.tasksReadOnly')}
          </p>
        ) : (
          <>
            <Card small>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Icon name="checkCircle" size={17} style={{ color: 'var(--success)' }} />
                <span className="title-sm">{status?.email}</span>
              </div>
              <div className="label-sm" style={{ marginTop: '0.375rem' }}>
                {t('google.calendarLabel', { name: status?.syncCalendarName ?? '—' })}
              </div>
              <div className="label-sm">
                {t('google.lastSynced', { when: status?.lastSyncedAt ? f.dateTime(status.lastSyncedAt) : t('google.never') })}
              </div>
            </Card>

            <Field label={t('google.pickCalendar')}>
              {calendars === null ? (
                <Button variant="matte" size="sm" icon="calendar" onClick={loadCalendars}>{t('google.changeCalendar')}</Button>
              ) : (
                <div className="ui-stack" style={{ gap: '0.25rem' }}>
                  <CalendarRow
                    label={t('google.createOwn')}
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
                      hint={c.primary ? t('google.primary') : undefined}
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
