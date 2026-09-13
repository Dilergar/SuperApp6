'use client';

import { useElementWidth } from './chart-utils';

/**
 * Мини-график без осей: линия в приглушённом тоне, последняя точка — акцентом.
 * Декоративный спутник числа (значение всегда рядом текстом), поэтому aria-hidden.
 */
export function Sparkline({ values, height = 28 }: { values: number[]; height?: number }) {
  const [ref, width] = useElementWidth<HTMLSpanElement>(120);
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => 3 + (n <= 1 ? 0 : (i / (n - 1)) * (width - 6));
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <span ref={ref} aria-hidden style={{ display: 'block', width: '100%', minWidth: 60 }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {n > 1 && <path d={d} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
        {n > 0 && <circle cx={x(n - 1)} cy={y(values[n - 1])} r={2.5} fill="var(--series-1)" />}
      </svg>
    </span>
  );
}
