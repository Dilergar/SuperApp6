'use client';

import { Alert, Button, Input, ModalShell } from '@/components/ui';
/**
 * Диалоги безопасности профиля (движок core/verify):
 *  - Смена пароля: текущий пароль + SMS-код на свой номер (Kaspi-модель step-up);
 *    другие сессии отзываются, текущая живёт.
 *  - Смена номера (строгий v1): пароль + SMS-код на СТАРЫЙ номер + SMS-код на НОВЫЙ.
 *    Старый номер недоступен → смена пока невозможна (честный текст, без мёртвых кнопок).
 *
 * Пароль уходит уже в /verify/step-up: сервер проверяет его ДО отправки SMS. Раньше
 * «неверный текущий пароль» выяснялось после сожжённого кода — человек платил за SMS
 * и начинал сначала.
 */

import { useState } from 'react';
import { normalizePhone } from '@superapp/shared';
import { REFRESH_TOKEN_KEY, apiErrorMessage, apiPost } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';
import { useTranslations } from 'next-intl';

function DialogFrame({ children, onClose, busy, label }: { children: React.ReactNode; onClose: () => void; busy: boolean; label: string }) {
  return (
    <ModalShell onClose={() => !busy && onClose()} zIndex={200} label={label}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: '460px', width: '100%', padding: 'var(--spacing-6)' }}>
        {children}
      </div>
    </ModalShell>
  );
}

const refreshToken = () => (typeof window === 'undefined' ? undefined : localStorage.getItem(REFRESH_TOKEN_KEY) || undefined);

// ============================================================
// Смена пароля
// ============================================================

/**
 * `via: 'not_me'` — смена пароля из мастера «Это не я» (событие журнала несёт источник);
 * `onDone` — пароль сменён (мастер отмечает шаг выполненным).
 */
export function ChangePasswordDialog({ onClose, onDone, via }: { onClose: () => void; onDone?: () => void; via?: 'settings' | 'not_me' }) {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const flow = useOtpFlow();
  const [step, setStep] = useState<'form' | 'code' | 'done'>('form');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Пароль проверит сервер до отправки кода — неверный вернётся сюда же, без SMS.
      await flow.startStepUp('password_change', currentPassword);
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const verifyToken = await flow.check(code);
    if (!verifyToken) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/users/me/change-password', {
        currentPassword,
        newPassword,
        verifyToken,
        currentRefreshToken: refreshToken(),
        ...(via ? { via } : {}),
      });
      setStep('done');
      onDone?.();
    } catch (err) {
      setError(apiErrorMessage(err));
      setStep('form'); // неверный текущий пароль и т.п. — назад к форме
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame onClose={onClose} busy={busy} label={t('pwd.dialogLabel')}>
      {step === 'form' && (
        <form onSubmit={requestCode}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>{t('pwd.title')}</h3>
          {error && <div style={{ marginBottom: 'var(--spacing-3)' }}><Alert tone="danger">{error}</Alert></div>}
          <Input
            label={t('pwd.current')}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            wrapClassName="mb-5"
          />
          <Input
            label={t('pwd.new')}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            placeholder={t('pwd.newPlaceholder')}
            autoComplete="new-password"
          />
          <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', marginBottom: 'var(--spacing-5)', opacity: 0.7 }}>
            {t('pwd.note')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{common('actions.cancel')}</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !currentPassword || !newPassword}>
              {busy ? t('pwd.sending') : t('pwd.getCode')}
            </Button>
          </div>
        </form>
      )}

      {step === 'code' && (
        <OtpStep
          flow={flow}
          onSubmit={submitCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel={t('pwd.back')}
          title={t('pwd.confirm')}
        />
      )}

      {step === 'done' && (
        <div>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('pwd.doneTitle')}</h3>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-5)', lineHeight: 1.55 }}>
            {t('pwd.doneText')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={onClose}>{t('pwd.done')}</Button>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}

// ============================================================
// Смена номера
// ============================================================

export function ChangePhoneDialog({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const flow = useOtpFlow();
  const fetchProfile = useAuthStore((s) => s.fetchProfile);
  const [step, setStep] = useState<'form' | 'code_old' | 'code_new' | 'done'>('form');
  const [password, setPassword] = useState('');
  const [newPhone, setNewPhone] = useState('+7');
  const [oldToken, setOldToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * Шаг «форма». Если старый номер в этой же модалке уже подтверждён (например,
   * новый номер оказался занят и мы вернулись сюда), второй SMS на старый номер не
   * шлём — пропуск живёт 15 минут, сразу запрашиваем код на новый номер.
   */
  const submitForm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (oldToken) {
        flow.reset();
        await flow.startStepUp('phone_change_new', password, normalizePhone(newPhone));
        setStep('code_new');
      } else {
        await flow.startStepUp('phone_change_old', password);
        setStep('code_old');
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitOldCode = async (code: string) => {
    const token = await flow.check(code);
    if (!token) return;
    setOldToken(token);
    setError('');
    setBusy(true);
    try {
      flow.reset();
      await flow.startStepUp('phone_change_new', password, normalizePhone(newPhone));
      setStep('code_new');
    } catch (err) {
      // Номер занят и т.п. — назад к форме с сообщением (старый пропуск сохранён)
      setError(apiErrorMessage(err));
      setStep('form');
    } finally {
      setBusy(false);
    }
  };

  const submitNewCode = async (code: string) => {
    const newToken = await flow.check(code);
    if (!newToken) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/users/me/change-phone', {
        password,
        newPhone: normalizePhone(newPhone),
        oldVerifyToken: oldToken,
        newVerifyToken: newToken,
        currentRefreshToken: refreshToken(),
      });
      await fetchProfile();
      setStep('done');
      onDone?.();
    } catch (err) {
      setError(apiErrorMessage(err));
      setStep('form');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame onClose={onClose} busy={busy} label={t('phone.dialogLabel')}>
      {step === 'form' && (
        <form onSubmit={submitForm}>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('phone.title')}</h3>
          <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', lineHeight: 1.5, opacity: 0.8 }}>
            {t('phone.note')}
          </p>
          {error && <div style={{ marginBottom: 'var(--spacing-3)' }}><Alert tone="danger">{error}</Alert></div>}
          <Input
            label={t('phone.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            wrapClassName="mb-5"
          />
          <Input
            label={t('phone.new')}
            type="tel"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            required
            placeholder="+77001234567"
            autoComplete="tel"
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', marginTop: 'var(--spacing-5)' }}>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{common('actions.cancel')}</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !password}>
              {busy ? t('pwd.sending') : oldToken ? t('phone.codeToNew') : t('phone.codeToOld')}
            </Button>
          </div>
        </form>
      )}

      {step === 'code_old' && (
        <OtpStep
          flow={flow}
          onSubmit={submitOldCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel={t('pwd.back')}
          title={t('phone.oldTitle')}
        />
      )}

      {step === 'code_new' && (
        <OtpStep
          flow={flow}
          onSubmit={submitNewCode}
          onBack={() => { flow.reset(); setStep('form'); }}
          backLabel={t('pwd.back')}
          title={t('phone.newTitle')}
        />
      )}

      {step === 'done' && (
        <div>
          <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('phone.doneTitle')}</h3>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-5)', lineHeight: 1.55 }}>
            {t('phone.doneText')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={onClose}>{t('pwd.done')}</Button>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}
