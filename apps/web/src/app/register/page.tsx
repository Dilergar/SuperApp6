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
import { Alert, Button, Input } from '@/components/ui';
import { AuthLayout } from '../auth-ui';

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
    <AuthLayout
      title="Создать аккаунт"
      subtitle="Один аккаунт — для всей жизни"
      step={{ current: stepIdx, total: STEPS.length, labels: STEPS.map((s) => s.label) }}
      footer={<>Уже есть аккаунт? <Link href="/login" style={{ fontWeight: 700 }}>Войти</Link></>}
    >
      {/* ===== Шаг 1: номер ===== */}
      {step === 'phone' && (
        <form onSubmit={requestCode} style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          {phoneError && (
            <Alert tone="danger">
              {phoneError}
              {phoneTaken && (
                <div style={{ marginTop: '0.5rem', display: 'flex', gap: 'var(--spacing-4)' }}>
                  <Link href="/login" style={{ fontWeight: 700 }}>Войти</Link>
                  <Link href="/reset-password" style={{ fontWeight: 700 }}>Забыли пароль?</Link>
                </div>
              )}
            </Alert>
          )}

          <Input
            label="Телефон"
            type="tel"
            icon="device"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+77001234567"
            hint="Отправим SMS с кодом подтверждения"
            autoComplete="tel"
            required
            autoFocus
          />

          <Button type="submit" variant="primary" size="lg" block loading={phoneBusy}>
            {phoneBusy ? 'Отправляем…' : 'Получить код'}
          </Button>

          <p className="label-sm" style={{ textAlign: 'center', margin: 0 }}>
            Бесплатный пробный период — 3 месяца
          </p>
        </form>
      )}

      {/* ===== Шаг 2: код ===== */}
      {step === 'code' && (
        <OtpStep flow={flow} onSubmit={submitCode} onBack={() => { flow.reset(); setStep('phone'); }} />
      )}

      {/* ===== Шаг 3: о себе ===== */}
      {step === 'profile' && (
        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
          {error && (
            <Alert tone="danger">
              {error}
              {tokenStale && (
                <button
                  type="button"
                  onClick={() => { setError(''); setTokenStale(false); void requestCode(); }}
                  style={{ display: 'block', marginTop: '0.4rem', background: 'none', border: 'none', padding: 0, fontWeight: 700, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                >
                  Получить новый код
                </button>
              )}
            </Alert>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--spacing-4)' }}>
            <Input label="Имя" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Санжар" required autoFocus />
            <Input label="Фамилия" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Не обяз." />
          </div>

          <Input
            label="Дата рождения"
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            hint="Не обязательно — скрыта по умолчанию"
          />

          <Input
            label="Пароль"
            type="password"
            icon="lock"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Минимум 8 символов"
            autoComplete="new-password"
            required
          />

          <Button type="submit" variant="primary" tone="success" size="lg" block loading={loading}>
            {loading ? 'Создаём…' : 'Создать аккаунт'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
