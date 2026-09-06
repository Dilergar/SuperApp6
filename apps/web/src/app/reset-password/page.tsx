'use client';

/**
 * «Забыли пароль?» — восстановление через SMS-код (движок core/verify):
 *   номер → код → новый пароль → АВТОВХОД (человек только что доказал владение
 *   номером — заставлять логиниться снова бессмысленно; все старые сессии отозваны).
 * Ответ первого шага нейтрален («если номер зарегистрирован — код отправлен»):
 * существование аккаунта не раскрывается (OWASP), SMS на чужие номера не тратятся.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  normalizePhone,
  type AuthTokens,
} from '@superapp/shared';
import { apiErrorMessage, apiPost } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { isTokenStale, useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';
import { Alert, Button, Input } from '@/components/ui';
import { useTranslations } from 'next-intl';
import { AuthLayout } from '../auth-ui';

type Step = 'phone' | 'code' | 'password';

export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const applySession = useAuthStore((s) => s.applySession);
  const flow = useOtpFlow();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [tokenStale, setTokenStale] = useState(false);

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      await flow.startPublic(normalizePhone(phone), 'password_reset');
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const token = await flow.check(code);
    if (token) {
      setVerifyToken(token);
      setStep('password');
    }
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setTokenStale(false);
    setBusy(true);
    try {
      const tokens = await apiPost<AuthTokens>('/auth/password-reset', { verifyToken, newPassword });
      await applySession(tokens);
      router.push('/dashboard');
    } catch (err) {
      setError(apiErrorMessage(err));
      // Машинный код из details — текст сообщения может поменяться в любой момент.
      if (isTokenStale(err)) setTokenStale(true);
    } finally {
      setBusy(false);
    }
  };

  const STEP_IDX = { phone: 0, code: 1, password: 2 } as const;

  return (
    <AuthLayout
      title={t('reset.title')}
      subtitle={t('reset.subtitle')}
      step={{ current: STEP_IDX[step], total: 3, labels: [t('reset.stepPhone'), t('reset.stepCode'), t('reset.stepPassword')] }}
      footer={<>{t('reset.remembered')} <Link href="/login" style={{ fontWeight: 700 }}>{t('login.submit')}</Link></>}
    >
      {error && step !== 'code' && (
        <Alert tone="danger" className="reset-error">
          {error}
          {tokenStale && (
            <button
              type="button"
              onClick={() => { setError(''); setTokenStale(false); void requestCode(); }}
              style={{ display: 'block', marginTop: '0.4rem', background: 'none', border: 'none', padding: 0, fontWeight: 700, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
            >
              {t('register.newCode')}
            </button>
          )}
        </Alert>
      )}

      {step === 'phone' && (
        <form onSubmit={requestCode} className="ui-stack" style={{ gap: 'var(--spacing-4)', marginTop: error ? 'var(--spacing-4)' : 0 }}>
          <Input
            label={t('login.phone')}
            type="tel"
            icon="device"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+77001234567"
            hint={t('reset.phoneHint')}
            autoComplete="tel"
            required
            autoFocus
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {busy ? t('register.sending') : t('register.getCode')}
          </Button>
        </form>
      )}

      {step === 'code' && (
        <OtpStep flow={flow} onSubmit={submitCode} onBack={() => { flow.reset(); setStep('phone'); }} />
      )}

      {step === 'password' && (
        <form onSubmit={handleComplete} className="ui-stack" style={{ gap: 'var(--spacing-4)', marginTop: error ? 'var(--spacing-4)' : 0 }}>
          <Input
            label={t('reset.newPassword')}
            type="password"
            icon="lock"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('login.passwordPlaceholder')}
            hint={t('reset.newPasswordHint')}
            autoComplete="new-password"
            required
            autoFocus
          />
          <Button type="submit" variant="primary" tone="success" size="lg" block loading={busy}>
            {busy ? t('reset.saving') : t('reset.submit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
