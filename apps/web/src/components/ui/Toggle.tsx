'use client';

// ============================================================
// Toggle (тумблер) / Checkbox — переключатели.
// Тумблер включён = зелёный (правило дизайн-пакета), не акцентный.
// ============================================================
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './tones';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Подпись справа от тумблера. */
  label?: ReactNode;
  /** Пояснение под подписью. */
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Toggle({ checked, onChange, label, description, disabled, className, ...aria }: ToggleProps) {
  const id = useId();
  const control = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={!label ? aria['aria-label'] : undefined}
      className="ui-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-knob" />
    </button>
  );

  if (!label && !description) return <span className={className}>{control}</span>;

  return (
    <div className={cx(className)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-4)' }}>
      <div style={{ minWidth: 0 }}>
        {label && (
          <label htmlFor={id} style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--on-surface)', cursor: disabled ? 'default' : 'pointer' }}>
            {label}
          </label>
        )}
        {description && <div style={{ fontSize: '0.6875rem', fontWeight: 500, color: 'var(--muted)', marginTop: '0.125rem' }}>{description}</div>}
      </div>
      {control}
    </div>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  /** Зачеркнуть подпись (выполненная задача). */
  strikethrough?: boolean;
}

export function Checkbox({ checked, onChange, label, strikethrough, disabled, className, id, ...rest }: CheckboxProps) {
  const auto = useId();
  const boxId = id ?? auto;
  const input = (
    <input
      id={boxId}
      type="checkbox"
      className="ui-check"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      {...rest}
    />
  );
  if (!label) return <span className={className}>{input}</span>;
  return (
    <label
      htmlFor={boxId}
      className={cx(className)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: '0.8125rem', fontWeight: 500, color: 'var(--on-surface)',
        opacity: strikethrough && checked ? 0.65 : 1,
      }}
    >
      {input}
      <span style={{ textDecoration: strikethrough && checked ? 'line-through' : undefined }}>{label}</span>
    </label>
  );
}
