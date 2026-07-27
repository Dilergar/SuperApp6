// ============================================================
// Матовые тона — базовый приём системы (DESIGN.md §1).
// Заливка rgba(база,0.12–0.16) + бордер rgba(база,0.30–0.35) + тёмный текст.
//
// Тон отдаётся компонентам CSS-переменными (--tone-bg/--tone-border/--tone-fg),
// чтобы один и тот же набор классов красил и кнопку, и чип, и алерт.
// ============================================================
import type { CSSProperties } from 'react';

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

interface ToneVars extends CSSProperties {
  '--tone-bg': string;
  '--tone-border': string;
  '--tone-fg': string;
  '--tone-bg-strong': string;
  /** Цвет заливки/иконки — насыщенная база тона (для точек, полосок, иконок). */
  '--tone-base': string;
  /** Сплошная заливка кнопки этого тона + её ховер и свечение тени. */
  '--tone-solid': string;
  '--tone-solid-hover': string;
  '--tone-glow': string;
}

const TONES: Record<Tone, ToneVars> = {
  accent: {
    '--tone-bg': 'rgba(88, 140, 211, 0.12)',
    '--tone-border': 'rgba(88, 140, 211, 0.3)',
    '--tone-fg': 'var(--primary-dim)',
    '--tone-bg-strong': 'rgba(88, 140, 211, 0.2)',
    '--tone-base': 'var(--primary)',
    '--tone-solid': '#588cd3',
    '--tone-solid-hover': '#3f6aa8',
    '--tone-glow': 'rgba(88, 140, 211, 0.3)',
  },
  success: {
    '--tone-bg': 'rgba(116, 162, 119, 0.14)',
    '--tone-border': 'rgba(116, 162, 119, 0.32)',
    '--tone-fg': 'var(--success)',
    '--tone-bg-strong': 'rgba(116, 162, 119, 0.22)',
    '--tone-base': 'var(--success-base)',
    '--tone-solid': '#74a277',
    '--tone-solid-hover': '#5f8c63',
    '--tone-glow': 'rgba(116, 162, 119, 0.32)',
  },
  warning: {
    '--tone-bg': 'rgba(214, 150, 108, 0.16)',
    '--tone-border': 'rgba(214, 150, 108, 0.35)',
    '--tone-fg': 'var(--warning)',
    '--tone-bg-strong': 'rgba(214, 150, 108, 0.24)',
    '--tone-base': 'var(--warning-base)',
    '--tone-solid': '#d6966c',
    '--tone-solid-hover': '#bd7f57',
    '--tone-glow': 'rgba(214, 150, 108, 0.34)',
  },
  danger: {
    '--tone-bg': 'rgba(222, 109, 104, 0.14)',
    '--tone-border': 'rgba(222, 109, 104, 0.32)',
    '--tone-fg': 'var(--danger)',
    '--tone-bg-strong': 'rgba(222, 109, 104, 0.22)',
    '--tone-base': 'var(--danger-base)',
    '--tone-solid': '#de6d68',
    '--tone-solid-hover': '#c25a55',
    '--tone-glow': 'rgba(222, 109, 104, 0.32)',
  },
  neutral: {
    '--tone-bg': 'var(--surface-container)',
    '--tone-border': 'var(--border)',
    '--tone-fg': 'var(--on-surface-variant)',
    '--tone-bg-strong': 'var(--active)',
    '--tone-base': 'var(--muted)',
    '--tone-solid': '#6b655e',
    '--tone-solid-hover': '#565049',
    '--tone-glow': 'rgba(0, 0, 0, 0.12)',
  },
};

/** Переменные тона — расстелить в style компонента. */
export function toneVars(tone: Tone = 'neutral'): CSSProperties {
  return TONES[tone];
}

/** Насыщенный цвет тона — когда нужен чистый цвет, а не матовая пара. */
export const TONE_BASE: Record<Tone, string> = {
  accent: 'var(--primary)',
  success: 'var(--success-base)',
  warning: 'var(--warning-base)',
  danger: 'var(--danger-base)',
  neutral: 'var(--muted)',
};

/** Класс-хелпер: склеивает классы, отбрасывая пустые. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
