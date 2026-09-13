'use client';

import { Tooltip } from '../Tooltip';
import { ChartFrame } from './ChartFrame';

export interface CohortRowView {
  key: string;
  label: string;
  size: number | null;
  masked: boolean;
  values: Array<number | null>;
}

export interface CohortGridProps {
  columns: string[];
  rows: CohortRowView[];
  formatPercent: (share: number) => string;
  formatNumber: (v: number) => string;
  maskedHint: string;
  headers: { cohort: string; size: string };
  ariaLabel: string;
  dimmed?: boolean;
}

/**
 * Когортная сетка: интенсивность ОДНОГО тона (шкала, а не категории) через color-mix,
 * в ячейке — число. Скрытая когорта — «—» с подсказкой о приватности.
 */
export function CohortGrid({ columns, rows, formatPercent, formatNumber, maskedHint, headers, ariaLabel, dimmed }: CohortGridProps) {
  const table = {
    columns: [headers.cohort, headers.size, ...columns],
    rows: rows.map((r) => ({
      key: r.key,
      cells: [r.label, r.size === null ? '—' : formatNumber(r.size), ...r.values.map((v) => (v === null ? '—' : formatPercent(v)))],
    })),
  };
  const template = `minmax(6.5rem, auto) minmax(3.5rem, auto) repeat(${columns.length}, minmax(2.75rem, 1fr))`;
  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      <div style={{ overflowX: 'auto' }}>
        <div role="img" aria-label={ariaLabel} style={{ display: 'grid', gridTemplateColumns: template, gap: 2, minWidth: 'max-content', fontSize: '0.6875rem' }}>
          <span className="label-caps">{headers.cohort}</span>
          <span className="label-caps" style={{ textAlign: 'end' }}>{headers.size}</span>
          {columns.map((c) => (
            <span key={c} className="label-caps" style={{ textAlign: 'center' }}>{c}</span>
          ))}
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'contents' }}>
              <span className="body-sm" style={{ whiteSpace: 'nowrap', paddingInlineEnd: '0.5rem' }}>{r.label}</span>
              <span style={{ textAlign: 'end', fontVariantNumeric: 'tabular-nums', paddingInlineEnd: '0.5rem' }}>
                {r.masked || r.size === null ? (
                  <Tooltip content={maskedHint}>
                    <span tabIndex={0}>—</span>
                  </Tooltip>
                ) : (
                  formatNumber(r.size)
                )}
              </span>
              {r.values.map((v, i) => {
                const strength = v === null ? 0 : Math.round(8 + v * 82);
                const dark = strength >= 55;
                return (
                  <span
                    key={i}
                    style={{
                      textAlign: 'center',
                      padding: '0.3rem 0.125rem',
                      borderRadius: 4,
                      fontVariantNumeric: 'tabular-nums',
                      background: v === null ? 'var(--surface-container)' : `color-mix(in srgb, var(--series-1) ${strength}%, var(--surface-container-lowest))`,
                      color: dark ? 'var(--surface-container-lowest)' : 'var(--on-surface)',
                      fontWeight: dark ? 700 : 500,
                    }}
                  >
                    {v === null ? '' : formatPercent(v)}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
