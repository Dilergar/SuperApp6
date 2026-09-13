'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/stores/auth';
import { analytics } from '@/lib/analytics';
import { Alert, Button, Input } from '@/components/ui';
import { useTranslations } from 'next-intl';
import { AuthLayout } from '../auth-ui';

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [deletedNote, setDeletedNote] = useState(false);

  useEffect(() => {
    setDeletedNote(new URLSearchParams(window.location.search).get('deleted') === '1');
    analytics.track('auth.login.opened', {});
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
      setError(axiosErr.response?.data?.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={t('login.title')}
      subtitle={t('login.subtitle')}
      footer={
        <>
          {t('login.noAccount')} <Link href="/register" style={{ fontWeight: 700 }}>{t('login.createAccount')}</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {deletedNote && (
          <Alert tone="warning" title={t('login.deletedTitle')}>
            {t('login.deletedText')}
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}

        <Input
          label={t('login.phone')}
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
            {/* Настоящий <label>, а не <span>: иначе у поля нет подписи для скринридера
                (он читал плейсхолдер «Минимум 8 символов») и по подписи нельзя кликнуть.
                Свой ряд нужен, потому что справа стоит ссылка «Забыли пароль?». */}
            <label className="ui-field-label" htmlFor="login-password">
              {t('login.password')}<span style={{ color: 'var(--danger)' }}> *</span>
            </label>
            <Link href="/reset-password" className="label-sm" style={{ fontWeight: 700 }}>{t('login.forgot')}</Link>
          </div>
          <Input
            id="login-password"
            type="password"
            icon="lock"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('login.passwordPlaceholder')}
            autoComplete="current-password"
            required
          />
        </div>

        <Button type="submit" variant="primary" size="lg" block loading={loading}>
          {loading ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
