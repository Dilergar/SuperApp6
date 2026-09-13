'use client';

import { useState } from 'react';
import { Chip } from '../Chip';
import { ChartFrame } from './ChartFrame';
import { SeriesKey, niceTicks, seriesColor, tickIndexes, useElementWidth } from './chart-utils';

export interface StackSegment {
  key: string;
  label: string;
  slot: number;
  values: number[];
  /** Сегмент уходит ВНИЗ от нуля (уснувшие в lifecycle) */
  negative?: boolean;
}

export interface StackedBarsProps {
  labels: string[];
  segments: StackSegment[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  height?: number;
  dimmed?: boolean;
}

const PAD = { top: 12, bottom: 26, left: 46, right: 8 };

/**
 * Колонки-стопки по периодам: положительные сегменты вверх от нуля, отрицательные —
 * вниз; между сегментами 2px зазор цвета поверхности, у крайних — скругление 4px.
 * Наведение/фокус на колонку — всплывашка со всеми сегментами.
 */
export function StackedBars({ labels, segments, formatValue, ariaLabel, height = 220, dimmed }: StackedBarsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const upMax = Math.max(0, ...labels.map((_, i) => segments.filter((s) => !s.negative).reduce((a, s) => a + (s.values[i] ?? 0), 0)));
  const downMax = Math.max(0, ...labels.map((_, i) => segments.filter((s) => s.negative).reduce((a, s) => a + (s.values[i] ?? 0), 0)));
  const ticksUp = niceTicks(upMax, 3, true);
  const topV = ticksUp[ticksUp.length - 1] || 1;
  const bottomV = downMax > 0 ? niceTicks(downMax, 2, true).slice(-1)[0] : 0;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const scale = plotH / (topV + bottomV);
  const zeroY = PAD.top + topV * scale;
  const band = plotW / Math.max(1, n);
  const barW = Math.min(24, Math.max(4, band * 0.6));
  const cx = (i: number) => PAD.left + band * i + band / 2;

  const table = {
    columns: ['', ...segments.map((s) => s.label)],
    rows: labels.map((l, i) => ({ key: `${i}`, cells: [l, ...segments.map((s) => formatValue(s.values[i] ?? 0))] })),
  };

  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-2)' }}>
        {segments.map((s) => (
          <Chip key={s.key} size="sm" tone="neutral">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <SeriesKey slot={s.slot} kind="rect" />
              {s.label}
            </span>
          </Chip>
        ))}
      </div>
      <div ref={ref} className="ui-chart" style={{ width: '100%' }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
          {[...ticksUp, ...(bottomV ? [-bottomV] : [])].map((tv) => (
            <g key={tv}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={zeroY - tv * scale} y2={zeroY - tv * scale} stroke={tv === 0 ? 'var(--border)' : 'var(--divider)'} />
              <text x={PAD.left - 8} y={zeroY - tv * scale + 4} textAnchor="end" className="ui-chart-axis">{formatValue(Math.abs(tv))}</text>
            </g>
          ))}
          {labels.map((_, i) => {
            let up = zeroY;
            let down = zeroY;
            const pos = segments.filter((s) => !s.negative && (s.values[i] ?? 0) > 0);
            const neg = segments.filter((s) => s.negative && (s.values[i] ?? 0) > 0);
            return (
              <g
                key={i}
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                opacity={hover === null || hover === i ? 1 : 0.7}
              >
                <rect x={cx(i) - band / 2} y={PAD.top} width={band} height={plotH} fill="transparent" />
                {pos.map((s, k) => {
                  const h = (s.values[i] ?? 0) * scale;
                  const yTop = up - h;
                  up = yTop;
                  const isTop = k === pos.length - 1;
                  return <rect key={s.key} x={cx(i) - barW / 2} y={yTop + (isTop ? 0 : 1)} width={barW} height={Math.max(0, h - (k === 0 ? 0 : 1) - (isTop ? 0 : 1))} rx={isTop ? 4 : 0} fill={seriesColor(s.slot)} />;
                })}
                {neg.map((s, k) => {
                  const h = (s.values[i] ?? 0) * scale;
                  const yTop = down;
                  down += h;
                  const isEnd = k === neg.length - 1;
                  return <rect key={s.key} x={cx(i) - barW / 2} y={yTop + (k === 0 ? 1 : 1)} width={barW} height={Math.max(0, h - 2)} rx={isEnd ? 4 : 0} fill={seriesColor(s.slot)} />;
                })}
              </g>
            );
          })}
          {tickIndexes(n, Math.max(2, Math.floor(plotW / 90))).map((i) => (
            <text key={i} x={cx(i)} y={height - 8} textAnchor="middle" className="ui-chart-axis">{labels[i]}</text>
          ))}
        </svg>
        {hover !== null && (
          <div className="ui-chart-tip" style={{ left: Math.min(Math.max(cx(hover) + 14, 0), width - 170), top: PAD.top }} role="status">
            <div className="ui-chart-tip-label" style={{ marginBottom: '0.25rem' }}>{labels[hover]}</div>
            {segments.map((s) => (
              <div key={s.key} className="ui-chart-tip-row">
                <SeriesKey slot={s.slot} kind="rect" />
                <strong>{formatValue(s.values[hover] ?? 0)}</strong>
                <span className="ui-chart-tip-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
