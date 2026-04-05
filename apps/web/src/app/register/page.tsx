'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await api.post('/auth/register', {
        firstName,
        lastName: lastName || undefined,
        phone,
        password,
      });
      localStorage.setItem('accessToken', data.data.accessToken);
      localStorage.setItem('refreshToken', data.data.refreshToken);
      router.push('/dashboard');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setError(axiosErr.response?.data?.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

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
        <p className="label-md" style={{ marginBottom: 'var(--spacing-10)', fontSize: '1rem' }}>
          Один аккаунт — для всей жизни
        </p>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="wash-primary" style={{
              padding: 'var(--spacing-3) var(--spacing-4)',
              marginBottom: 'var(--spacing-6)',
              color: 'var(--primary)',
              fontSize: '0.875rem',
            }}>
              {error}
            </div>
          )}

          {/* Name fields — asymmetric grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--spacing-6)', marginBottom: 'var(--spacing-8)' }}>
            <div>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Имя
              </label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Санжар"
                required
                className="input-sketch"
              />
            </div>
            <div>
              <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
                Фамилия
              </label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Не обяз."
                className="input-sketch"
              />
            </div>
          </div>

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
              className="input-sketch"
            />
          </div>

          <div style={{ marginBottom: 'var(--spacing-10)' }}>
            <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
              Пароль
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Минимум 8 символов"
              required
              className="input-sketch"
            />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full" style={{
            fontSize: '1.05rem',
            padding: 'var(--spacing-4)',
            opacity: loading ? 0.6 : 1,
          }}>
            {loading ? 'Создание...' : 'Создать аккаунт'}
          </button>

          <p className="label-sm" style={{ textAlign: 'center', marginTop: 'var(--spacing-4)' }}>
            Бесплатный пробный период — 3 месяца
          </p>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: 'var(--spacing-8)',
          color: 'var(--on-surface-variant)',
          fontSize: '0.9rem',
        }}>
          Уже есть аккаунт?{' '}
          <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
