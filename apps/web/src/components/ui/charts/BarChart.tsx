'use client';

import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip';
import { ChartFrame } from './ChartFrame';
import { seriesColor } from './chart-utils';

export interface BarRow {
  key: string;
  label: ReactNode;
  /** Текст подписи для таблицы и всплывашки */
  text: string;
  value: number | null;
  /** Значение прошлого периода — тонкая отметка на дорожке */
  previous?: number | null;
  /** Ячейка скрыта ради приватности (k-анонимность) */
  masked?: boolean;
}

export interface BarChartProps {
  rows: BarRow[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  /** Слот цвета: одна серия — один цвет у всех столбцов */
  slot?: number;
  /** Подсказка у скрытой ячейки */
  maskedHint: string;
  previousLabel?: string;
  /** Подписи колонок таблицы-дублёра */
  columns: [string, string];
  dimmed?: boolean;
}

/**
 * Горизонтальные столбцы «top-N»: подпись слева, дорожка, значение на кончике.
 * Толщина 14px, скругление 4px только на конце данных, у основания — прямой угол.
 * Скрытая ячейка — «—» с подсказкой о приватности; прошлый период — волосяная отметка.
 */
export function BarChart({ rows, formatValue, ariaLabel, slot = 0, maskedHint, previousLabel, columns, dimmed }: BarChartProps) {
  const max = Math.max(0, ...rows.flatMap((r) => [r.value ?? 0, r.previous ?? 0]));
  const pct = (v: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
  const table = {
    columns: previousLabel ? [columns[0], columns[1], previousLabel] : [columns[0], columns[1]],
    rows: rows.map((r) => ({
      key: r.key,
      cells: [
        r.text,
        r.masked || r.value === null ? '—' : formatValue(r.value),
        ...(previousLabel ? [r.previous === null || r.previous === undefined ? '—' : formatValue(r.previous)] : []),
      ],
    })),
  };
  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      <div role="img" aria-label={ariaLabel} style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {rows.map((r) => {
          const tip = (
            <span>
              <strong>{r.masked || r.value === null ? '—' : formatValue(r.value)}</strong> · {r.text}
              {r.masked ? ` — ${maskedHint}` : ''}
              {previousLabel && r.previous !== null && r.previous !== undefined ? ` · ${previousLabel}: ${formatValue(r.previous)}` : ''}
            </span>
          );
          return (
            <Tooltip key={r.key} content={tip}>
              <div
                tabIndex={0}
                className="ui-chart"
                style={{ display: 'grid', gridTemplateColumns: 'minmax(6rem, 34%) 1fr minmax(3.5rem, auto)', alignItems: 'center', gap: '0.625rem', padding: '0.125rem 0.25rem', borderRadius: 'var(--radius-sm)' }}
              >
                <span className="body-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                <span style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center' }}>
                  {!r.masked && r.value !== null && (
                    <span style={{ height: 14, width: `${pct(r.value)}%`, minWidth: r.value > 0 ? 3 : 0, background: seriesColor(slot), borderRadius: '0 4px 4px 0' }} />
                  )}
                  {r.previous !== null && r.previous !== undefined && !r.masked && (
                    <span aria-hidden style={{ position: 'absolute', left: `calc(${pct(r.previous)}% - 1px)`, top: 0, width: 2, height: 18, background: 'var(--on-surface-variant)', borderRadius: 1 }} />
                  )}
                </span>
                <span className="label-sm" style={{ textAlign: 'end', fontVariantNumeric: 'tabular-nums', color: 'var(--on-surface)' }}>
                  {r.masked || r.value === null ? '—' : formatValue(r.value)}
                </span>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </ChartFrame>
  );
}
