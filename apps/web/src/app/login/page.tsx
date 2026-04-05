'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/stores/auth';

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(phone, password);
      router.push('/dashboard');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setError(axiosErr.response?.data?.message || 'Ошибка входа');
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
          Войти
        </h1>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-10)', fontSize: '1rem' }}>
          Рады видеть вас снова
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

          <div style={{ marginBottom: 'var(--spacing-8)' }}>
            <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>
              Телефон
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+77001234567"
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
              className="input-sketch"
            />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full" style={{
            fontSize: '1.05rem',
            padding: 'var(--spacing-4)',
            opacity: loading ? 0.6 : 1,
          }}>
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: 'var(--spacing-8)',
          color: 'var(--on-surface-variant)',
          fontSize: '0.9rem',
        }}>
          Нет аккаунта?{' '}
          <Link href="/register" style={{ color: 'var(--primary)', fontWeight: 600 }}>
            Создать
          </Link>
        </p>
      </div>
    </div>
  );
}
