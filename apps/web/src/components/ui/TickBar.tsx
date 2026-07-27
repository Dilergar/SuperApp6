'use client';

// ============================================================
// TickBar — фирменный штриховой прогресс системы (DESIGN.md §5).
// Штрихи 2px с шагом 5px. Сплошных полосок в системе нет.
// ============================================================
import type { CSSProperties } from 'react';
import { TONE_BASE, type Tone } from './tones';

export interface TickBarProps {
  /** 0..100. Значения вне диапазона зажимаются. */
  value: number;
  tone?: Tone;
  height?: number;
  /** Подпись слева (капс) и значение справа. */
  label?: string;
  showValue?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}

function clamp(v: number) {
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
}

export function TickBar({ value, tone = 'accent', height = 10, label, showValue, className, style, ...aria }: TickBarProps) {
  const pct = clamp(value);
  const base = TONE_BASE[tone];
  return (
    <div className={className} style={style}>
      {(label || showValue) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
          {label && <span className="label-caps">{label}</span>}
          {showValue && (
            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--primary-dim)' }}>{Math.round(pct)}%</span>
          )}
        </div>
      )}
      <div
        className="tick-bar"
        style={{ height }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={aria['aria-label'] ?? label}
      >
        {/* Заполнение раскрывается clip-path'ом, а не width: клип не трогает layout
            (анимация width = пересчёт раскладки каждый кадр) и не масштабирует
            штрихи 2px/5px, как это сделал бы transform: scaleX. */}
        <div
          className="tick-bar-fill"
          style={{
            clipPath: `inset(0 ${100 - pct}% 0 0)`,
            background: `repeating-linear-gradient(90deg, ${base} 0 2px, transparent 2px 5px)`,
          }}
        />
      </div>
    </div>
  );
}

export interface GradientTickBarProps {
  value: number;
  /** 'green-red' — чем больше, тем хуже (риск). 'red-green' — наоборот (покрытие). */
  direction?: 'green-red' | 'red-green';
  height?: number;
  label?: string;
  showValue?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Градиентный штриховой индикатор: шкала окрашена целиком, непройденная
 * часть закрывается серыми тиками. Три слоя — см. DESIGN.md §5.
 */
export function GradientTickBar({
  value,
  direction = 'green-red',
  height = 14,
  label,
  showValue,
  className,
  style,
}: GradientTickBarProps) {
  const pct = clamp(value);
  const from = direction === 'green-red' ? 'var(--success-base)' : 'var(--danger-base)';
  const to = direction === 'green-red' ? 'var(--danger-base)' : 'var(--success-base)';
  const valueColor = direction === 'green-red' ? 'var(--danger)' : 'var(--success)';
  return (
    <div className={className} style={style}>
      {(label || showValue) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
          {label && <span className="label-caps">{label}</span>}
          {showValue && <span style={{ fontSize: '0.75rem', fontWeight: 800, color: valueColor }}>{Math.round(pct)}%</span>}
        </div>
      )}
      <div
        className="tick-bar-grad"
        style={
          {
            height,
            '--tick-from': from,
            '--tick-to': to,
            '--tick-rest': `${100 - pct}%`,
          } as CSSProperties
        }
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      />
    </div>
  );
}
