'use client';

// Разморозка аккаунта (core/audit): СТАРЫЙ пароль → код из SMS → автовход. Сброс пароля по
// SMS заморозку не снимает — только пароль, который был до заморозки, плюс номер.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { normalizePhone } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { unfreezeConfirm } from '@/lib/audit-api';
import { useAuthStore } from '@/lib/stores/auth';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';
import { Alert, Button, Input, Modal } from '@/components/ui';

export function UnfreezeDialog({ phone, onClose }: { phone: string; onClose: () => void }) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const applySession = useAuthStore((s) => s.applySession);
  const flow = useOtpFlow();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      await flow.startUnfreeze(normalizePhone(phone), password);
      setStep('code');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    const verifyToken = await flow.check(code);
    if (!verifyToken) return;
    setBusy(true);
    try {
      await applySession(await unfreezeConfirm(verifyToken));
      router.push('/dashboard');
    } catch (err) {
      setError(apiErrorMessage(err));
      flow.reset();
      setStep('password');
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} size="sm" title={t('login.unfreezeTitle')}>
      {step === 'password' ? (
        <form onSubmit={requestCode} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <p className="label-md" style={{ margin: 0, lineHeight: 1.55 }}>{t('login.unfreezeText')}</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Input label={t('login.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
          <p className="label-sm" style={{ margin: 0 }}>{t('login.unfreezeNoPassword')}</p>
          <div style={{ display: 'flex', gap: 'var(--spacing-3)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{tc('actions.cancel')}</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!password}>{t('freeze.getCode')}</Button>
          </div>
        </form>
      ) : (
        <OtpStep flow={flow} onSubmit={(code) => void submitCode(code)} onBack={() => { flow.reset(); setStep('password'); }} backLabel={tc('actions.back')} title={t('freeze.codeTitle')} />
      )}
    </Modal>
  );
}
