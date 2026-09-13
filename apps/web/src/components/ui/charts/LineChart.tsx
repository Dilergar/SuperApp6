'use client';

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Chip } from '../Chip';
import { ChartFrame } from './ChartFrame';
import { Marker, SeriesKey, niceTicks, seriesColor, seriesMarker, tickIndexes, useElementWidth } from './chart-utils';

export interface LineSeries {
  key: string;
  label: string;
  /** Закреплённый слот цвета/формы (сущность, а не место в рейтинге) */
  slot: number;
  /** Значение на каждой позиции оси X; null — нет данных (разрыв линии) */
  values: Array<number | null>;
  /** Пунктир — прошлый период для сравнения */
  dashed?: boolean;
}

export interface LineChartProps {
  /** Подписи оси X (уже отформатированные) */
  labels: string[];
  series: LineSeries[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  height?: number;
  /** Двойной клик по чипу легенды — «оставить только эту» (применить как фильтр) */
  onIsolate?: (key: string) => void;
  dimmed?: boolean;
  /** Счётная величина — деления оси только целые */
  integer?: boolean;
}

const PAD = { top: 14, bottom: 26, left: 46 };

/**
 * Линии: 2px, маркеры разной формы, подпись на конце (≤ 4 видимых серии без
 * столкновений), перекрестие со всплывашкой по всем сериям у ближайшей позиции X,
 * клавиатура (←/→), легенда-чипы при ≥ 2 сериях, таблица-дублёр.
 */
export function LineChart({ labels, series, formatValue, ariaLabel, height = 220, onIsolate, dimmed, integer }: LineChartProps) {
  const t = useTranslations('common');
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const visible = series.filter((s) => !hidden.has(s.key));
  const n = labels.length;

  const max = Math.max(0, ...visible.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const ticks = niceTicks(max, 4, integer);
  const top = ticks[ticks.length - 1] || 1;

  // Подписи на концах — только когда серий 2–4 и они не сталкиваются (одну серию
  // называет заголовок графика, подпись на конце её лишь дублировала бы)
  const endLabels = useMemo(() => {
    const solid = visible.filter((s) => !s.dashed);
    if (solid.length < 2 || solid.length > 4 || width < 420) return null;
    const plotH = height - PAD.top - PAD.bottom;
    const items = solid
      .map((s) => {
        let i = s.values.length - 1;
        while (i >= 0 && s.values[i] === null) i--;
        return i < 0 ? null : { s, y: PAD.top + plotH - ((s.values[i] as number) / top) * plotH };
      })
      .filter((x): x is { s: LineSeries; y: number } => !!x)
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 13) return null;
    return items;
  }, [visible, width, height, top]);

  const right = endLabels ? 104 : 14;
  const plotW = Math.max(40, width - PAD.left - right);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  const pathOf = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = n <= 1 ? 0 : Math.round((px / box.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key);
      return next;
    });

  // Заливка — только у одной ПОЛНОЙ серии без пропусков: у короткой или рваной линии контур
  // «до нуля» начинался бы не с M (SVG отвергает такой `d` ошибкой в консоли)
  const single =
    visible.length === 1 && !visible[0].dashed && n > 1 && visible[0].values.length === n && visible[0].values.every((v) => v !== null);
  const markAll = n <= 14;
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover) + 12, 0), width - 170);

  const table = {
    columns: ['', ...series.map((s) => s.label)],
    rows: labels.map((label, i) => ({ key: `${i}`, cells: [label, ...series.map((s) => (s.values[i] === null ? '—' : formatValue(s.values[i] as number)))] })),
  };

  return (
    <ChartFrame table={table} caption={ariaLabel} dimmed={dimmed}>
      {series.length >= 2 && (
        <div role="group" aria-label={ariaLabel} title={onIsolate ? t('charts.legendHint') : undefined} style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: 'var(--spacing-2)' }}>
          {series.map((s) => (
            <span key={s.key} onDoubleClick={onIsolate ? () => onIsolate(s.key) : undefined}>
              <Chip size="sm" tone="neutral" selected={!hidden.has(s.key)} onClick={() => toggle(s.key)}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <SeriesKey slot={s.slot} dashed={s.dashed} />
                  {s.label}
                </span>
              </Chip>
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="ui-chart" tabIndex={0} aria-label={ariaLabel} onKeyDown={onKey} onBlur={() => setHover(null)} style={{ width: '100%' }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tv)} y2={y(tv)} stroke={tv === 0 ? 'var(--border)' : 'var(--divider)'} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(tv) + 4} textAnchor="end" className="ui-chart-axis">{formatValue(tv)}</text>
            </g>
          ))}
          {tickIndexes(n, Math.max(2, Math.floor(plotW / 90))).map((i) => (
            <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} className="ui-chart-axis">
              {labels[i]}
            </text>
          ))}
          {single && (
            <path
              d={`${pathOf(visible[0].values)} L${x(n - 1)} ${y(0)} L${x(0)} ${y(0)} Z`}
              fill={seriesColor(visible[0].slot)}
              opacity={0.1}
            />
          )}
          {visible.map((s) => (
            <path
              key={s.key}
              d={pathOf(s.values)}
              fill="none"
              stroke={seriesColor(s.slot)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              opacity={s.dashed ? 0.8 : 1}
            />
          ))}
          {visible
            .filter((s) => !s.dashed)
            .map((s) =>
              s.values.map((v, i) => {
                const last = s.values.slice(i + 1).every((x2) => x2 === null);
                if (v === null || !(markAll || last || hover === i)) return null;
                return <Marker key={`${s.key}-${i}`} shape={seriesMarker(s.slot)} x={x(i)} y={y(v)} color={seriesColor(s.slot)} />;
              }),
            )}
          {endLabels?.map(({ s, y: ly }) => (
            <text key={s.key} x={PAD.left + plotW + 10} y={ly + 4} className="ui-chart-label">
              {s.label.length > 14 ? `${s.label.slice(0, 13)}…` : s.label}
            </text>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--control-border)" strokeWidth={1} />}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <div className="ui-chart-tip" style={{ left: tipLeft, top: PAD.top }} role="status">
            <div className="ui-chart-tip-label" style={{ marginBottom: '0.25rem' }}>{labels[hover]}</div>
            {[...visible]
              .sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1))
              .map((s) => (
                <div key={s.key} className="ui-chart-tip-row">
                  <SeriesKey slot={s.slot} dashed={s.dashed} />
                  <strong>{s.values[hover] === null ? '—' : formatValue(s.values[hover] as number)}</strong>
                  <span className="ui-chart-tip-label">{s.label}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
