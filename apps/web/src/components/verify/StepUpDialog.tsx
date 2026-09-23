'use client';

// ============================================================
// Подтверждение «это я» для залогиненного человека: пароль → код из SMS (core/verify,
// `/verify/step-up`). Одна модалка на все цели: ключи (`keys_manage`), подтверждение
// новой сессии (`security_confirm`) и будущие. Вызывающий получает `verifyToken` и сам
// гасит его в своей ручке — диалог о смысле подтверждения ничего не знает.
// Пароль сервер проверяет ДО отправки SMS: неверный пароль не сжигает код.
// ============================================================

import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { VerifyPurpose } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { useOtpFlow } from './otp-flow';
import { OtpStep } from './OtpStep';
import { Alert, Button, Input, Modal } from '@/components/ui';

export type StepUpPurpose = Extract<VerifyPurpose, 'keys_manage' | 'security_confirm'>;

export interface StepUpDialogProps {
  open: boolean;
  purpose: StepUpPurpose;
  onClose: () => void;
  /** Пропуск получен — вызывающий гасит его в своей ручке; ошибка возвращает к паролю. */
  onVerified: (verifyToken: string) => Promise<void>;
  title?: string;
  body?: ReactNode;
  codeTitle?: string;
}

export function StepUpDialog({ open, purpose, onClose, onVerified, title, body, codeTitle }: StepUpDialogProps) {
  const t = useTranslations('common');
  const flow = useOtpFlow();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    flow.reset();
    setStep('password');
    setPassword('');
    setError('');
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const requestCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      await flow.startStepUp(purpose, password);
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
    try {
      await onVerified(verifyToken);
      reset();
    } catch (err) {
      setError(apiErrorMessage(err));
      flow.reset();
      setStep('password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={title ?? t('stepUp.title')} size="sm">
      {step === 'password' && (
        <form onSubmit={requestCode} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ lineHeight: 1.55 }}>{body ?? t('stepUp.body')}</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Input
            label={t('stepUp.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('actions.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy || !password} loading={busy}>{t('stepUp.getCode')}</Button>
          </div>
        </form>
      )}
      {step === 'code' && (
        <OtpStep flow={flow} onSubmit={submitCode} onBack={() => { flow.reset(); setStep('password'); }} backLabel={t('stepUp.back')} title={codeTitle ?? t('stepUp.codeTitle')} />
      )}
    </Modal>
  );
}
