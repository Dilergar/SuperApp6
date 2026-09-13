'use client';

import { Icon } from '../Icon';
import { ChartFrame } from './ChartFrame';
import { seriesColor } from './chart-utils';

export interface FunnelStepView {
  key: string;
  label: string;
  count: number;
  /** Доля от предыдущего шага (0..1) */
  fromPrevious: number | null;
  fromStart: number | null;
  previousCount?: number | null;
}

export interface FunnelChartProps {
  steps: FunnelStepView[];
  biggestDropIndex: number | null;
  formatNumber: (v: number) => string;
  formatPercent: (share: number) => string;
  /** «−42 % отвалились» — подпись перехода */
  dropLabel: (dropShare: number) => string;
  columns: [string, string, string];
  ariaLabel: string;
  dimmed?: boolean;
}

/**
 * Воронка: шаг — дорожка с долей от первого шага и абсолютом; между шагами — строка
 * перехода с процентом отвала. Самый большой отвал выделен ФОРМОЙ (иконка, жирная
 * подпись), а не цветом тревоги.
 */
export function FunnelChart({ steps, biggestDropIndex, formatNumber, formatPercent, dropLabel, columns, ariaLabel, dimmed }: FunnelChartProps) {
  const first = steps[0]?.count ?? 0;
  const table = {
    columns,
    rows: steps.map((s) => ({
      key: s.key,
      cells: [s.label, formatNumber(s.count), s.fromStart === null ? '—' : formatPercent(s.fromStart)],
    })),
  };
  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      <ol role="img" aria-label={ariaLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {steps.map((s, i) => {
          const share = first > 0 ? s.count / first : 0;
          const drop = i > 0 && s.fromPrevious !== null ? 1 - s.fromPrevious : null;
          const worst = i === biggestDropIndex;
          return (
            <li key={s.key}>
              {i > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.125rem 0 0.25rem', color: 'var(--on-surface-variant)', fontSize: '0.75rem', fontWeight: worst ? 800 : 500 }}>
                  <Icon name={worst ? 'trendDown' : 'arrowDown'} size={worst ? 16 : 13} />
                  <span>{drop === null ? '—' : dropLabel(drop)}</span>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, 34%) 1fr auto', alignItems: 'center', gap: '0.625rem' }}>
                <span className="body-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                <span style={{ height: 22, background: 'var(--surface-container)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.max(s.count > 0 ? 1 : 0, share * 100)}%`, background: seriesColor(0), borderRadius: '0 4px 4px 0' }} />
                </span>
                <span className="label-sm" style={{ textAlign: 'end', color: 'var(--on-surface)', fontVariantNumeric: 'tabular-nums', minWidth: '6.5rem' }}>
                  <strong>{formatNumber(s.count)}</strong> · {s.fromStart === null ? '—' : formatPercent(s.fromStart)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
