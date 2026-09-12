'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { PlatformLoginResponse, VerifyCheckResponse, VerifyStartResponse } from '@superapp/shared';
import { Alert, Button, Input } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { AuthLayout } from '@/app/auth-ui';
import { useAuthStore } from '@/lib/stores/auth';
import { usePlatformAuthStore } from '@/lib/stores/platform-auth';
import { apiErrorMessage, platformPublicGet, platformPublicPost } from '@/lib/platform-api';
import { formatCountdown } from '@/lib/format';

// ============================================================
// Вход в кабинет: шаг 1 — пароль (телефон известен из продуктовой сессии, если она
// есть; иначе поле телефона), шаг 2 — код из SMS. Ошибки — по `details.code`
// (текст сервер уже перевёл). После входа — на страницу, с которой пришли.
// ============================================================

export default function PlatformLoginPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const router = useRouter();
  const search = useSearchParams();
  const productPhone = useAuthStore((s) => s.user?.phone ?? null);
  const status = usePlatformAuthStore((s) => s.status);
  const hydrate = usePlatformAuthStore((s) => s.hydrate);
  const applyToken = usePlatformAuthStore((s) => s.applyToken);
  const next = search.get('next') && search.get('next')!.startsWith('/platform') ? search.get('next')! : '/platform';

  const [phone, setPhone] = useState(productPhone ?? '+7');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<VerifyStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendLeft, setResendLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (status === 'idle') void hydrate();
    if (status === 'ready') router.replace(next);
  }, [status, hydrate, router, next]);
  useEffect(() => {
    if (productPhone) setPhone(productPhone);
  }, [productPhone]);
  useEffect(() => {
    if (resendLeft <= 0) return;
    const timer = setInterval(() => setResendLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await platformPublicPost<VerifyStartResponse>('/platform/auth/start', { phone, password });
      setChallenge(r);
      setResendLeft(r.resendInSec);
      setCode('');
      try {
        const d = await platformPublicGet<{ code: string | null }>(`/verify/dev/last-code?challengeId=${r.challengeId}`);
        setDevCode(d.code);
      } catch {
        setDevCode(null);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (value: string) => {
    if (!challenge) return;
    setBusy(true);
    setError('');
    try {
      const chk = await platformPublicPost<VerifyCheckResponse>('/verify/check', { challengeId: challenge.challengeId, code: value });
      const res = await platformPublicPost<PlatformLoginResponse>('/platform/auth/login', { verifyToken: chk.verifyToken });
      await applyToken(res.accessToken);
      router.replace(next);
    } catch (err) {
      setError(apiErrorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('login.title')} subtitle={challenge ? t('login.codeSubtitle', { phone: challenge.phoneMasked }) : t('login.subtitle')}>
      {!challenge ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          className="ui-stack"
          style={{ gap: 'var(--spacing-4)' }}
        >
          <Input label={t('login.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" disabled={!!productPhone} />
          <Input type="password" label={t('login.password')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" loading={busy} disabled={!password || phone.length < 11}>
            {t('login.continue')}
          </Button>
        </form>
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => void finish(v)} error={!!error} disabled={busy} />
          {error && <Alert tone="danger">{error}</Alert>}
          {devCode && <p className="label-sm">{tc.rich('otp.devCode', { code: devCode, b: (chunk) => <b>{chunk}</b> })}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button variant="ghost" size="sm" icon="refresh" disabled={resendLeft > 0 || busy} onClick={() => void start()}>
              {resendLeft > 0 ? tc('otp.resendIn', { time: formatCountdown(resendLeft) }) : tc('otp.resend')}
            </Button>
            <Button variant="ghost" size="sm" icon="arrowLeft" disabled={busy} onClick={() => setChallenge(null)}>
              {t('login.back')}
            </Button>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
