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
import { normalizePhone } from '@superapp/shared';
import { api, apiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/lib/stores/auth';
import { isTokenStale, useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';

type Step = 'phone' | 'code' | 'password';

export default function ResetPasswordPage() {
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
      const { data } = await api.post('/auth/password-reset', { verifyToken, newPassword });
      await applySession(data.data);
      router.push('/dashboard');
    } catch (err) {
      setError(apiErrorMessage(err));
      // Машинный код из details — текст сообщения может поменяться в любой момент.
      if (isTokenStale(err)) setTokenStale(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link
          href="/login"
          className="label-md inline-block"
          style={{ marginBottom: 'var(--spacing-8)', color: 'var(--on-surface-variant)' }}
        >
          ← ко входу
        </Link>

        <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>
          Восстановление
        </h1>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-10)', fontSize: '1rem' }}>
          Подтвердите номер — и задайте новый пароль
        </p>

        {error && step !== 'code' && (
          <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', color: 'var(--primary)', fontSize: '0.875rem' }}>
            {error}
            {tokenStale && (
              <button
                type="button"
                onClick={() => { setError(''); setTokenStale(false); void requestCode(); }}
                style={{ display: 'block', marginTop: 'var(--spacing-2)', background: 'none', border: 'none', padding: 0, fontWeight: 700, color: 'var(--secondary)', cursor: 'pointer' }}
              >
                Получить новый код
              </button>
            )}
          </div>
        )}

        {step === 'phone' && (
          <form onSubmit={requestCode}>
            <div style={{ marginBottom: 'var(--spacing-8)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Телефон
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+77001234567"
                required
                autoFocus
                className="input-sketch"
              />
              <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', opacity: 0.7 }}>
                Если номер зарегистрирован — отправим SMS с кодом
              </p>
            </div>
            <button type="submit" disabled={busy} className="btn-primary w-full" style={{ fontSize: '1.05rem', padding: 'var(--spacing-4)', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Отправка…' : 'Получить код'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <OtpStep
            flow={flow}
            onSubmit={submitCode}
            onBack={() => {
              flow.reset();
              setStep('phone');
            }}
          />
        )}

        {step === 'password' && (
          <form onSubmit={handleComplete}>
            <div style={{ marginBottom: 'var(--spacing-10)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Новый пароль
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Минимум 8 символов"
                required
                autoFocus
                className="input-sketch"
                autoComplete="new-password"
              />
              <p className="label-sm" style={{ marginTop: 'var(--spacing-2)', opacity: 0.7 }}>
                Заглавная и строчная буквы, цифра и спецсимвол. Все старые сессии будут завершены
              </p>
            </div>
            <button type="submit" disabled={busy} className="btn-primary w-full" style={{ fontSize: '1.05rem', padding: 'var(--spacing-4)', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Сохранение…' : 'Сменить пароль и войти'}
            </button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: 'var(--spacing-8)', color: 'var(--on-surface-variant)', fontSize: '0.9rem' }}>
          Вспомнили пароль?{' '}
          <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
