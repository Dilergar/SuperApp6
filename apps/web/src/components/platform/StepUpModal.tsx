'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlatformStepUpResponse, VerifyCheckResponse, VerifyStartResponse } from '@superapp/shared';
import { Alert, Button, Input, Modal } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { apiErrorMessage, platformPost, platformPublicGet, platformPublicPost } from '@/lib/platform-api';
import { usePlatformAuthStore } from '@/lib/stores/platform-auth';
import { formatCountdown } from '@/lib/format';

// ============================================================
// Step-up (sudo) кабинета: пароль → код из SMS → окно 15 минут. Своя мини-цепочка,
// а не `useOtpFlow`: старт идёт с ТОКЕНОМ КАБИНЕТА (`/platform/auth/step-up/start`),
// продуктовый транспорт для него не годится. Проверка кода — публичная ручка движка.
// ============================================================

export function StepUpModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const setSudoUntil = usePlatformAuthStore((s) => s.setSudoUntil);
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<VerifyStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendLeft, setResendLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setPassword('');
      setChallenge(null);
      setCode('');
      setDevCode(null);
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (resendLeft <= 0) return;
    const timer = setInterval(() => setResendLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await platformPost<VerifyStartResponse>('/platform/auth/step-up/start', { password });
      setChallenge(r);
      setResendLeft(r.resendInSec);
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

  const confirm = async (value: string) => {
    if (!challenge) return;
    setBusy(true);
    setError('');
    try {
      const chk = await platformPublicPost<VerifyCheckResponse>('/verify/check', { challengeId: challenge.challengeId, code: value });
      const res = await platformPost<PlatformStepUpResponse>('/platform/auth/step-up/confirm', { verifyToken: chk.verifyToken });
      setSudoUntil(res.sudoUntil);
      onDone?.();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('stepUp.title')}
      subtitle={t('stepUp.subtitle')}
      size="sm"
      footer={
        !challenge ? (
          <Button variant="primary" loading={busy} disabled={!password} onClick={() => void start()}>
            {t('stepUp.sendCode')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" icon="refresh" disabled={resendLeft > 0 || busy} onClick={() => void start()}>
            {resendLeft > 0 ? tc('otp.resendIn', { time: formatCountdown(resendLeft) }) : tc('otp.resend')}
          </Button>
        )
      }
    >
      {!challenge ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          className="ui-stack"
          style={{ gap: 'var(--spacing-4)' }}
        >
          <Input type="password" autoComplete="current-password" label={t('stepUp.password')} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <p className="body-sm">
            {tc('otp.sentTo')} <b>{challenge.phoneMasked}</b>
          </p>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => void confirm(v)} error={!!error} disabled={busy} />
          {error && <Alert tone="danger">{error}</Alert>}
          {devCode && (
            <p className="label-sm">{tc.rich('otp.devCode', { code: devCode, b: (chunk) => <b>{chunk}</b> })}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
