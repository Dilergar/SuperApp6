'use client';

/**
 * Экран/блок «введите код из SMS» — единое представление шага кода для
 * регистрации, сброса пароля и step-up модалок профиля. Показывает: куда ушёл
 * код (маска номера), ячейки CodeInput (автосабмит), кнопку повторной отправки
 * с серверным таймером, «← изменить номер» и dev-подсказку кода (только когда
 * API в development-режиме отдаёт её ручкой last-code).
 */

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
  backLabel = '← изменить номер',
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
      <h2 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>{title}</h2>
      <p className="label-md" style={{ marginBottom: 'var(--spacing-6)', lineHeight: 1.5 }}>
        Отправили код на <b style={{ whiteSpace: 'nowrap' }}>{flow.phoneMasked || 'ваш номер'}</b>
      </p>

      {status && !status.smsEnabled && (
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)', opacity: 0.7, lineHeight: 1.45 }}>
          Отправка SMS не настроена — сообщение не придёт, код возьмите из подсказки ниже.
        </p>
      )}

      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <CodeInput
          value={flow.code}
          onChange={flow.setCode}
          onComplete={onSubmit}
          error={!!flow.error}
          disabled={flow.busy}
        />
      </div>

      {flow.error && (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 'var(--spacing-3)' }}>{flow.error}</p>
      )}

      {flow.devCode && (
        <p className="label-sm" style={{ marginBottom: 'var(--spacing-3)', opacity: 0.65 }}>
          [dev] код: <b>{flow.devCode}</b>
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-5)', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={flow.resend}
          disabled={flow.resendLeft > 0 || flow.busy}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: flow.resendLeft > 0 || flow.busy ? 'default' : 'pointer',
            color: flow.resendLeft > 0 ? 'var(--on-surface-variant)' : 'var(--secondary)',
            fontWeight: 600,
            fontSize: '0.85rem',
          }}
        >
          {flow.resendLeft > 0
            ? `Отправить ещё раз (${formatCountdown(flow.resendLeft)})`
            : 'Отправить ещё раз'}
        </button>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={flow.busy}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--on-surface-variant)',
              fontSize: '0.85rem',
            }}
          >
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
