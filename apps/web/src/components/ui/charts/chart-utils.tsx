'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

// ============================================================
// Общее кита графиков: слоты серий, маркеры, шкала, ширина контейнера.
// Цвет — ТОЛЬКО токены `--series-N` (globals.css); слот закреплён за сущностью, а не
// за местом в рейтинге: фильтр, убравший серию, не перекрашивает оставшиеся.
// ============================================================

export const SERIES_SLOTS = 6;
const mod = (slot: number) => ((Math.floor(slot) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS;

/** Цвет слота серии. */
export const seriesColor = (slot: number) => `var(--series-${mod(slot) + 1})`;

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'ring' | 'cross';
const SHAPES: MarkerShape[] = ['circle', 'square', 'triangle', 'diamond', 'ring', 'cross'];

/** Форма маркера слота — второй канал различения (палитра матовая, одного цвета мало). */
export const seriesMarker = (slot: number): MarkerShape => SHAPES[mod(slot)];

const SURFACE = 'var(--surface-container-lowest)';

/** Маркер серии с 2px кольцом цвета поверхности (читается поверх линий). */
export function Marker({ shape, x, y, r = 4.5, color }: { shape: MarkerShape; x: number; y: number; r?: number; color: string }) {
  switch (shape) {
    case 'square':
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} fill={color} stroke={SURFACE} strokeWidth={2} />;
    case 'triangle':
      return <path d={`M${x} ${y - r - 1.5} L${x + r + 1.5} ${y + r} L${x - r - 1.5} ${y + r} Z`} fill={color} stroke={SURFACE} strokeWidth={2} strokeLinejoin="round" />;
    case 'diamond':
      return <path d={`M${x} ${y - r - 1.5} L${x + r + 1.5} ${y} L${x} ${y + r + 1.5} L${x - r - 1.5} ${y} Z`} fill={color} stroke={SURFACE} strokeWidth={2} strokeLinejoin="round" />;
    case 'ring':
      return <circle cx={x} cy={y} r={r} fill={SURFACE} stroke={color} strokeWidth={2.5} />;
    case 'cross':
      return (
        <g>
          <circle cx={x} cy={y} r={r + 1.5} fill={SURFACE} />
          <path d={`M${x - r} ${y - r} L${x + r} ${y + r} M${x + r} ${y - r} L${x - r} ${y + r}`} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
        </g>
      );
    default:
      return <circle cx={x} cy={y} r={r} fill={color} stroke={SURFACE} strokeWidth={2} />;
  }
}

/** Ключ серии в легенде и всплывашке: короткий штрих цвета + маркер формы (или прямоугольник для столбцов). */
export function SeriesKey({ slot, kind = 'line', dashed }: { slot: number; kind?: 'line' | 'rect'; dashed?: boolean }) {
  const color = seriesColor(slot);
  return (
    <svg width={20} height={12} aria-hidden style={{ flex: '0 0 auto', display: 'inline-block' }}>
      {kind === 'rect' ? (
        <rect x={3} y={2} width={14} height={8} rx={2} fill={color} />
      ) : (
        <>
          <line x1={1} y1={6} x2={19} y2={6} stroke={color} strokeWidth={2} strokeDasharray={dashed ? '3 3' : undefined} strokeLinecap="round" />
          <Marker shape={seriesMarker(slot)} x={10} y={6} r={3} color={color} />
        </>
      )}
    </svg>
  );
}

/** «Круглые» деления шкалы от нуля: 0 / 50 / 100 / 150. */
export function niceTicks(maxValue: number, count = 4, integer = false): number[] {
  if (!(maxValue > 0)) return [0, 1];
  const raw = maxValue / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  // Счётные величины (люди, события) делятся только на целые: «0,25 человека» не бывает
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(maxValue / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Ширина элемента (ResizeObserver): SVG рисуется в настоящих пикселях, текст не растягивается. */
export function useElementWidth<T extends HTMLElement>(fallback = 600): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** Индексы подписей оси X: не больше `max`, равномерно, всегда первый и последний. */
export function tickIndexes(n: number, max = 6): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  return Array.from(new Set(Array.from({ length: max }, (_, i) => Math.round(i * step))));
}
