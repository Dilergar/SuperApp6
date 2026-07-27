'use client';

/**
 * Экран/блок «введите код из SMS» — единое представление шага кода для
 * регистрации, сброса пароля и step-up модалок профиля. Показывает: куда ушёл
 * код (маска номера), ячейки CodeInput (автосабмит), кнопку повторной отправки
 * с серверным таймером, «Изменить номер» и dev-подсказку кода (только когда
 * API в development-режиме отдаёт её ручкой last-code).
 */

import { Alert, Button } from '@/components/ui';
import { CodeInput } from './CodeInput';
import { useVerifyStatus } from './use-verify-status';
import type { OtpFlow } from './otp-flow';

/** Секунды → «м:сс» (кулдаун доходит до 120 и «0:120» выглядел бы поломкой). */
function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function OtpStep({
  flow,
  onSubmit,
  onBack,
  backLabel = 'Изменить номер',
  title = 'Код из SMS',
}: {
  flow: OtpFlow;
  /** Вызывается с кодом при автосабмите/ручном сабмите. */
  onSubmit: (code: string) => void;
  onBack?: () => void;
  backLabel?: string;
  title?: string;
}) {
  const status = useVerifyStatus();

  return (
    <div>
      <h2 className="title-md" style={{ margin: '0 0 0.375rem' }}>{title}</h2>
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-5)' }}>
        Отправили код на <b style={{ whiteSpace: 'nowrap', color: 'var(--on-surface)' }}>{flow.phoneMasked || 'ваш номер'}</b>
      </p>

      {status && !status.smsEnabled && (
        <Alert tone="warning" className="otp-alert">
          Отправка SMS не настроена — сообщение не придёт, код возьмите из подсказки ниже.
        </Alert>
      )}

      <div style={{ margin: 'var(--spacing-4) 0' }}>
        <CodeInput
          value={flow.code}
          onChange={flow.setCode}
          onComplete={onSubmit}
          error={!!flow.error}
          disabled={flow.busy}
        />
      </div>

      {flow.error && <Alert tone="danger">{flow.error}</Alert>}

      {flow.devCode && (
        <p className="label-sm" style={{ margin: 'var(--spacing-3) 0 0' }}>
          [dev] код: <b>{flow.devCode}</b>
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: 'var(--spacing-4)' }}>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          onClick={flow.resend}
          disabled={flow.resendLeft > 0 || flow.busy}
        >
          {flow.resendLeft > 0 ? `Отправить ещё раз (${formatCountdown(flow.resendLeft)})` : 'Отправить ещё раз'}
        </Button>
        {onBack && (
          <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onBack} disabled={flow.busy}>
            {backLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
