'use client';

// Мастер «Это не я» (core/audit): 1 — что сделаем; 2 — сервер завершает чужие сессии, забывает
// устройства, отзывает личные ключи API и Google (одна транзакция + ключ повтора: двойной клик —
// одно действие); 3 — смена пароля; 4 — проверка номера; 5 — итог. Шаги 3–4 — существующие
// диалоги смены пароля и номера (пока открыт диалог, мастер прячется: две модалки не
// делят ловушку фокуса).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { NotMeResultDto, SecurityEventDto } from '@superapp/shared';
import { Alert, Button, EmojiIcon, Icon, Modal, TickBar } from '@/components/ui';
import { ChangePasswordDialog, ChangePhoneDialog } from '@/app/profile/[section]/security-dialogs';
import { notMeComplete, notMeStart } from '@/lib/audit-api';
import { apiErrorMessage } from '@/lib/api';
import { securityRootKey } from '@/lib/queries';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { useAuthStore } from '@/lib/stores/auth';
import { useEventMeta } from './SecurityEventParts';
import { eventIcon } from './event-visuals';

type Step = 'intro' | 'protect' | 'password' | 'phone' | 'done';

/** Адрес страницы заморозки без входа — его стоит запомнить на случай кражи телефона. */
export const freezeUrl = () => (typeof window === 'undefined' ? '/freeze' : `${window.location.host}/freeze`);
const PROGRESS: Record<Step, number> = { intro: 0, protect: 25, password: 50, phone: 75, done: 100 };

/** «+7 700 ••• 45 67» — номер человека маской: мастер не показывает его целиком. */
function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 10) return phone ?? '';
  return `+${d.slice(0, d.length - 10)} ${d.slice(-10, -7)} ••• ${d.slice(-4, -2)} ${d.slice(-2)}`;
}

export function NotMeWizard({ event, onClose }: { event: SecurityEventDto; onClose: () => void }) {
  const t = useTranslations('audit');
  const tc = useTranslations('common');
  const meta = useEventMeta();
  const qc = useQueryClient();
  const phone = useAuthStore((s) => s.user?.phone ?? null);
  const idem = useIdempotencyKey([event.id]);
  const [step, setStep] = useState<Step>('intro');
  const [result, setResult] = useState<NotMeResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'password' | 'phone' | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);

  const protect = async () => {
    setStep('protect');
    setBusy(true);
    setError('');
    try {
      setResult(await notMeStart(event.id, idem.key));
      idem.reset();
      void qc.invalidateQueries({ queryKey: securityRootKey });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (numberOk: boolean) => {
    setBusy(true);
    try {
      await notMeComplete({ eventId: event.id, passwordChanged, phoneConfirmed: numberOk });
    } catch {
      /* итог мастера — отметка в журнале; защита уже выполнена на шаге 2 */
    } finally {
      setBusy(false);
      setPhoneConfirmed(numberOk);
      setStep('done');
    }
  };

  const doneLines = result
    ? [
        t('ui.notMe.sessions', { n: result.sessionsRevoked }),
        t('ui.notMe.devices', { n: result.devicesForgotten }),
        t('ui.notMe.keys', { n: result.keysRevoked }),
        ...(result.googleDisconnected ? [t('ui.notMe.google')] : []),
      ]
    : [];

  const checks = (lines: string[]) => (
    <ul aria-live="polite" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {lines.map((l) => (
        <li key={l} className="body-sm" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Icon name="check" size={16} style={{ color: 'var(--success)' }} />
          {l}
        </li>
      ))}
    </ul>
  );

  const cannotClose = busy && step === 'protect';

  return (
    <>
      <Modal open={dialog === null} onClose={() => { if (!cannotClose) onClose(); }} size="md" title={t('ui.notMe.title')} closeOnBackdrop={false}>
        <TickBar value={PROGRESS[step]} tone={step === 'done' ? 'success' : 'accent'} label={t('ui.notMe.progress')} />
        <div style={{ marginTop: 'var(--spacing-5)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          {step === 'intro' && (
            <>
              <div className="ui-row" style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'center', padding: 'var(--spacing-3)' }}>
                <EmojiIcon emoji={eventIcon(event)} tone="warning" size={36} />
                <div style={{ minWidth: 0 }}>
                  <div className="title-sm">{event.title}</div>
                  <div className="label-sm">{meta(event)}</div>
                </div>
              </div>
              <h3 className="title-md" style={{ margin: 0 }}>{t('ui.notMe.step1Title')}</h3>
              <p className="body-sm" style={{ margin: 0, lineHeight: 1.55 }}>{t('ui.notMe.step1Text')}</p>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
                <Button variant="primary" tone="danger" icon="shieldWarning" onClick={() => void protect()}>{t('ui.notMe.start')}</Button>
              </div>
            </>
          )}

          {step === 'protect' && (
            <>
              {busy && <p className="body-sm" aria-live="polite" style={{ margin: 0 }}>{t('ui.notMe.working')}</p>}
              {error && (
                <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void protect()}>{tc('actions.retry')}</Button>}>
                  {error}
                </Alert>
              )}
              {result && checks(doneLines)}
              {result && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="primary" onClick={() => setStep('password')}>{tc('actions.continue')}</Button>
                </div>
              )}
            </>
          )}

          {step === 'password' && (
            <>
              <h3 className="title-md" style={{ margin: 0 }}>{t('ui.notMe.step3Title')}</h3>
              <p className="body-sm" style={{ margin: 0, lineHeight: 1.55 }}>{t('ui.notMe.step3Text')}</p>
              {passwordChanged && checks([t('ui.notMe.passwordChanged')])}
              <p className="label-sm" style={{ margin: 0 }}>{t('ui.notMe.forgotWarning')}</p>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button variant="outline" href="/reset-password">{t('ui.notMe.forgot')}</Button>
                {passwordChanged ? (
                  <Button variant="primary" onClick={() => setStep('phone')}>{tc('actions.continue')}</Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={() => setStep('phone')}>{t('ui.notMe.skip')}</Button>
                    <Button variant="primary" icon="fingerprint" onClick={() => setDialog('password')}>{t('ui.notMe.changePassword')}</Button>
                  </>
                )}
              </div>
            </>
          )}

          {step === 'phone' && (
            <>
              <h3 className="title-md" style={{ margin: 0 }}>{t('ui.notMe.step4Title')}</h3>
              <p className="body-sm" style={{ margin: 0 }}>{t('ui.notMe.step4Text', { phone: maskPhone(phone) })}</p>
              <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button variant="outline" disabled={busy} onClick={() => setDialog('phone')}>{t('ui.notMe.changePhone')}</Button>
                <Button variant="primary" tone="success" loading={busy} onClick={() => void finish(true)}>{t('ui.notMe.yes')}</Button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <h3 className="title-md" style={{ margin: 0 }}>{t('ui.notMe.doneTitle')}</h3>
              {checks([...doneLines, ...(passwordChanged ? [t('ui.notMe.passwordChanged')] : []), ...(phoneConfirmed ? [t('ui.notMe.phoneConfirmed')] : [])])}
              <Alert tone="accent" icon="info">{t('ui.notMe.doneTip')}</Alert>
              <p className="label-sm" style={{ margin: 0 }}>{t('ui.notMe.freezeTip', { url: freezeUrl() })}</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" onClick={onClose}>{tc('actions.close')}</Button>
              </div>
            </>
          )}
        </div>
      </Modal>
      {dialog === 'password' && <ChangePasswordDialog via="not_me" onClose={() => setDialog(null)} onDone={() => setPasswordChanged(true)} />}
      {dialog === 'phone' && (
        <ChangePhoneDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void finish(true);
          }}
        />
      )}
    </>
  );
}
