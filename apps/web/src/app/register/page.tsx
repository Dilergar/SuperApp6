'use client';

/**
 * Регистрация — verify-first, 3 шага (модель Kaspi/WhatsApp, движок core/verify):
 *   1. номер → SMS-код (занятый номер узнаётся СРАЗУ, не после заполнения формы)
 *   2. код из SMS → одноразовый verifyToken
 *   3. имя/пароль → аккаунт (verifyToken гасится в транзакции создания)
 * Аккаунт не существует, пока номер не подтверждён — «занять чужой номер и получить
 * его приглашения» невозможно.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAxiosError } from 'axios';
import { normalizePhone } from '@superapp/shared';
import { useAuthStore } from '@/lib/stores/auth';
import { apiErrorMessage } from '@/lib/api';
import { isTokenStale, useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';

type Step = 'phone' | 'code' | 'profile';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'phone', label: 'Номер' },
  { key: 'code', label: 'Код' },
  { key: 'profile', label: 'О себе' },
];

export default function RegisterPage() {
  const router = useRouter();
  const register = useAuthStore((s) => s.register);
  const flow = useOtpFlow();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+7');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [phoneTaken, setPhoneTaken] = useState(false);
  const [verifyToken, setVerifyToken] = useState('');

  // Шаг 3
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [tokenStale, setTokenStale] = useState(false);
  const [loading, setLoading] = useState(false);

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setPhoneError('');
    setPhoneTaken(false);
    setPhoneBusy(true);
    try {
      await flow.startPublic(normalizePhone(phone), 'register');
      setStep('code');
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) setPhoneTaken(true);
      setPhoneError(apiErrorMessage(err));
    } finally {
      setPhoneBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const token = await flow.check(code);
    if (token) {
      setVerifyToken(token);
      setStep('profile');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setTokenStale(false);
    setLoading(true);
    try {
      await register({
        firstName,
        lastName: lastName || undefined,
        dateOfBirth: dateOfBirth || undefined,
        phone: normalizePhone(phone),
        password,
        verifyToken,
      });
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
      // Пропуск живёт 15 минут — заполнял(а) дольше → код нужно получить заново.
      // Ветвимся по машинному коду в details, а не по русскому тексту сообщения.
      if (isTokenStale(err)) setTokenStale(true);
    } finally {
      setLoading(false);
    }
  };

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        {/* Back link */}
        <Link
          href="/"
          className="label-md inline-block"
          style={{ marginBottom: 'var(--spacing-8)', color: 'var(--on-surface-variant)' }}
        >
          ← на главную
        </Link>

        <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>
          Создать аккаунт
        </h1>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-6)', fontSize: '1rem' }}>
          Один аккаунт — для всей жизни
        </p>

        {/* Прогресс: чернильные точки-шаги */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-8)' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50% 42% 55% 48%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: i <= stepIdx ? '#fff' : 'var(--on-surface-variant)',
                    background: i <= stepIdx ? 'var(--primary)' : 'transparent',
                    border: i <= stepIdx ? 'none' : `2px solid color-mix(in srgb, var(--outline-variant) 60%, transparent)`,
                    transform: `rotate(${(i - 1) * 4}deg)`,
                  }}
                >
                  {i + 1}
                </div>
                <span
                  className="label-sm"
                  style={{ fontWeight: i === stepIdx ? 700 : 500, color: i === stepIdx ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{ width: 26, height: 2, background: 'color-mix(in srgb, var(--outline-variant) 50%, transparent)', borderRadius: 2 }} />
              )}
            </div>
          ))}
        </div>

        {/* ===== Шаг 1: номер ===== */}
        {step === 'phone' && (
          <form onSubmit={requestCode}>
            {phoneError && (
              <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', color: 'var(--primary)', fontSize: '0.875rem' }}>
                {phoneError}
                {phoneTaken && (
                  <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', gap: 'var(--spacing-4)' }}>
                    <Link href="/login" style={{ fontWeight: 700, color: 'var(--primary)' }}>Войти</Link>
                    <Link href="/reset-password" style={{ fontWeight: 700, color: 'var(--secondary)' }}>Забыли пароль?</Link>
                  </div>
                )}
              </div>
            )}

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
                Отправим SMS с кодом подтверждения
              </p>
            </div>

            <button type="submit" disabled={phoneBusy} className="btn-primary w-full" style={{ fontSize: '1.05rem', padding: 'var(--spacing-4)', opacity: phoneBusy ? 0.6 : 1 }}>
              {phoneBusy ? 'Отправка…' : 'Получить код'}
            </button>

            <p className="label-sm" style={{ textAlign: 'center', marginTop: 'var(--spacing-4)' }}>
              Бесплатный пробный период — 3 месяца
            </p>
          </form>
        )}

        {/* ===== Шаг 2: код ===== */}
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

        {/* ===== Шаг 3: о себе ===== */}
        {step === 'profile' && (
          <form onSubmit={handleSubmit}>
            {error && (
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

            {/* Name fields — asymmetric grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--spacing-6)', marginBottom: 'var(--spacing-8)' }}>
              <div>
                <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                  Имя
                </label>
                <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Санжар" required autoFocus className="input-sketch" />
              </div>
              <div>
                <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                  Фамилия
                </label>
                <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Не обяз." className="input-sketch" />
              </div>
            </div>

            <div style={{ marginBottom: 'var(--spacing-8)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Дата рождения
                <span style={{ opacity: 0.6, marginLeft: '0.4rem', fontSize: '0.75rem' }}>
                  не обяз. — скрыта по умолчанию
                </span>
              </label>
              <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className="input-sketch" />
            </div>

            <div style={{ marginBottom: 'var(--spacing-10)' }}>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Пароль
              </label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Минимум 8 символов" required className="input-sketch" autoComplete="new-password" />
            </div>

            <button type="submit" disabled={loading} className="btn-primary w-full" style={{ fontSize: '1.05rem', padding: 'var(--spacing-4)', opacity: loading ? 0.6 : 1 }}>
              {loading ? 'Создание…' : 'Создать аккаунт'}
            </button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: 'var(--spacing-8)', color: 'var(--on-surface-variant)', fontSize: '0.9rem' }}>
          Уже есть аккаунт?{' '}
          <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
