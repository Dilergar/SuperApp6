'use client';

/**
 * Экстренная заморозка без входа (core/audit): номер → код из SMS → вход, все сессии и личные
 * ключи API закрыты. Открывается с ЛЮБОГО устройства — телефон украден, аккаунт взломан.
 * Неизвестный номер получает тот же ответ (страница не выдаёт, есть ли такой аккаунт).
 * Разморозить может только владелец: старым паролем и кодом из SMS на экране входа —
 * сброс пароля по SMS заморозку не снимает (угнанная SIM его прошла бы).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { normalizePhone } from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import { freezeConfirm } from '@/lib/audit-api';
import { useOtpFlow } from '@/components/verify/otp-flow';
import { OtpStep } from '@/components/verify/OtpStep';
import { Alert, Button, EmojiIcon, Icon, Input } from '@/components/ui';
import { AuthLayout } from '../auth-ui';

type Step = 'phone' | 'code' | 'done';

export default function FreezePage() {
  const t = useTranslations('auth');
  const flow = useOtpFlow();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      await flow.startFreeze(normalizePhone(phone));
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
      await freezeConfirm(verifyToken);
      setStep('done');
    } catch (err) {
      setError(apiErrorMessage(err));
      flow.reset();
      setStep('phone');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') {
    return (
      <AuthLayout title={t('freeze.doneTitle')}>
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)', alignItems: 'flex-start' }}>
          <EmojiIcon emoji="snowflake" tone="accent" size={56} />
          <p className="body-md" style={{ margin: 0, lineHeight: 1.55 }}>{t('freeze.doneText')}</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(['done1', 'done2', 'done3'] as const).map((k) => (
              <li key={k} className="body-sm" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Icon name="check" size={16} style={{ color: 'var(--success)' }} />
                {t(`freeze.${k}`)}
              </li>
            ))}
          </ul>
          <Alert tone="accent" icon="lockOpen">{t('freeze.howTo')}</Alert>
          <Button variant="primary" href="/login" block>{t('freeze.toLogin')}</Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('freeze.title')}
      subtitle={t('freeze.subtitle')}
      footer={<Link href="/login" style={{ fontWeight: 700 }}>{t('freeze.toLogin')}</Link>}
    >
      {step === 'phone' && (
        <form onSubmit={requestCode} className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <p className="body-sm" style={{ margin: 0, lineHeight: 1.55 }}>{t('freeze.text')}</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Input
            label={t('freeze.phone')}
            type="tel"
            icon="device"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+77001234567"
            autoComplete="tel"
            required
            autoFocus
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {t('freeze.getCode')}
          </Button>
        </form>
      )}
      {step === 'code' && (
        <OtpStep
          flow={flow}
          onSubmit={(code) => void submitCode(code)}
          onBack={() => { flow.reset(); setStep('phone'); }}
          backLabel={t('freeze.changeNumber')}
          title={t('freeze.codeTitle')}
        />
      )}
    </AuthLayout>
  );
}
