'use client';

// ============================================================
// Alert — матовая плашка сообщения (успех / предупреждение / ошибка / инфо).
// ============================================================
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, type Tone } from './tones';

export interface AlertProps {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  /** Своя иконка вместо подобранной по тону. */
  icon?: IconName;
  /** Крестик закрытия. */
  onClose?: () => void;
  /** Кнопки действий справа. */
  action?: ReactNode;
  className?: string;
}

const TONE_ICON: Record<Tone, IconName> = {
  accent: 'info',
  success: 'checkCircle',
  warning: 'warning',
  danger: 'warningCircle',
  waiting: 'pending',
  neutral: 'info',
};

export function Alert({ children, tone = 'accent', title, icon, onClose, action, className }: AlertProps) {
  return (
    <div
      className={cx(className)}
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{
        ...toneVars(tone),
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.625rem',
        padding: '0.75rem 0.875rem',
        borderRadius: 'var(--radius-md)',
        background: 'var(--tone-bg)',
        border: '1px solid var(--tone-border)',
        color: 'var(--tone-fg)',
        fontSize: '0.75rem',
        fontWeight: 600,
        lineHeight: 1.5,
      }}
    >
      <Icon name={icon ?? TONE_ICON[tone]} size={17} style={{ marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 800, marginBottom: '0.2rem' }}>{title}</div>}
        {children}
      </div>
      {action}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, opacity: 0.7, display: 'inline-flex' }}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
