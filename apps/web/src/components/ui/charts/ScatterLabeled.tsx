'use client';

import { useState } from 'react';
import { ChartFrame } from './ChartFrame';
import { Marker, niceTicks, seriesColor, seriesMarker, useElementWidth } from './chart-utils';

export interface ScatterPoint {
  key: string;
  label: string;
  slot: number;
  x: number;
  y: number;
}

export interface ScatterLabeledProps {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  formatX: (v: number) => string;
  formatY: (v: number) => string;
  ariaLabel: string;
  height?: number;
  dimmed?: boolean;
}

const PAD = { top: 16, right: 24, bottom: 40, left: 52 };

/**
 * Матрица с подписями: точка = сущность, подпись видна ВСЕГДА (без легенды-угадайки).
 * Цель наведения — 24px вокруг точки, фокус с клавиатуры показывает то же.
 */
export function ScatterLabeled({ points, xLabel, yLabel, formatX, formatY, ariaLabel, height = 280, dimmed }: ScatterLabeledProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const xt = niceTicks(Math.max(0, ...points.map((p) => p.x)), 4);
  const yt = niceTicks(Math.max(0, ...points.map((p) => p.y)), 4);
  const xMax = xt[xt.length - 1] || 1;
  const yMax = yt[yt.length - 1] || 1;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const px = (v: number) => PAD.left + (v / xMax) * plotW;
  const py = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const active = points.find((p) => p.key === hover) ?? null;

  const table = {
    columns: ['', xLabel, yLabel],
    rows: points.map((p) => ({ key: p.key, cells: [p.label, formatX(p.x), formatY(p.y)] })),
  };

  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      <div ref={ref} className="ui-chart" style={{ width: '100%' }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
          {yt.map((v) => (
            <g key={`y${v}`}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={py(v)} y2={py(v)} stroke={v === 0 ? 'var(--border)' : 'var(--divider)'} />
              <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end" className="ui-chart-axis">{formatY(v)}</text>
            </g>
          ))}
          {xt.map((v) => (
            <text key={`x${v}`} x={px(v)} y={PAD.top + plotH + 16} textAnchor="middle" className="ui-chart-axis">{formatX(v)}</text>
          ))}
          <text x={PAD.left + plotW / 2} y={height - 4} textAnchor="middle" className="ui-chart-axis">{xLabel}</text>
          <text x={12} y={PAD.top + plotH / 2} textAnchor="middle" className="ui-chart-axis" transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}>{yLabel}</text>
          {points.map((p) => {
            const x = px(p.x);
            const y = py(p.y);
            const anchorEnd = x > PAD.left + plotW - 90;
            return (
              <g
                key={p.key}
                tabIndex={0}
                aria-label={`${p.label}: ${formatX(p.x)}, ${formatY(p.y)}`}
                onPointerEnter={() => setHover(p.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.key)}
                onBlur={() => setHover(null)}
              >
                <circle cx={x} cy={y} r={12} fill="transparent" />
                <Marker shape={seriesMarker(p.slot)} x={x} y={y} r={hover === p.key ? 6 : 4.5} color={seriesColor(p.slot)} />
                <text x={anchorEnd ? x - 9 : x + 9} y={y - 7} textAnchor={anchorEnd ? 'end' : 'start'} className="ui-chart-label">{p.label}</text>
              </g>
            );
          })}
        </svg>
        {active && (
          <div className="ui-chart-tip" style={{ left: Math.min(Math.max(px(active.x) + 14, 0), width - 170), top: Math.max(0, py(active.y) - 10) }} role="status">
            <div className="ui-chart-tip-label" style={{ marginBottom: '0.25rem', color: 'var(--on-surface)', fontWeight: 700 }}>{active.label}</div>
            <div className="ui-chart-tip-row"><strong>{formatX(active.x)}</strong><span className="ui-chart-tip-label">{xLabel}</span></div>
            <div className="ui-chart-tip-row"><strong>{formatY(active.y)}</strong><span className="ui-chart-tip-label">{yLabel}</span></div>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
