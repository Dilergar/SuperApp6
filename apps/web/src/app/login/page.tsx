'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/stores/auth';
import { Alert, Button, Input } from '@/components/ui';
import { AuthLayout } from '../auth-ui';

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [deletedNote, setDeletedNote] = useState(false);

  useEffect(() => {
    setDeletedNote(new URLSearchParams(window.location.search).get('deleted') === '1');
  }, []);

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
    <AuthLayout
      title="Войти"
      subtitle="Рады видеть вас снова"
      footer={
        <>
          Нет аккаунта? <Link href="/register" style={{ fontWeight: 700 }}>Создать</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        {deletedNote && (
          <Alert tone="warning" title="Аккаунт помечен на удаление">
            У вас есть 30 дней — войдите, чтобы восстановить его.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}

        <Input
          label="Телефон"
          type="tel"
          icon="device"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+77001234567"
          autoComplete="tel"
          required
        />

        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span className="ui-field-label">Пароль</span>
            <Link href="/reset-password" className="label-sm" style={{ fontWeight: 700 }}>Забыли пароль?</Link>
          </div>
          <Input
            type="password"
            icon="lock"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Минимум 8 символов"
            autoComplete="current-password"
            required
          />
        </div>

        <Button type="submit" variant="primary" size="lg" block loading={loading}>
          {loading ? 'Входим…' : 'Войти'}
        </Button>
      </form>
    </AuthLayout>
  );
}
