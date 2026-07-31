// ============================================================
// Матовые тона — базовый приём системы (DESIGN.md §1).
// Заливка rgba(база,0.12–0.16) + бордер rgba(база,0.30–0.35) + тёмный текст.
//
// Тон отдаётся компонентам CSS-переменными (--tone-bg/--tone-border/--tone-fg),
// чтобы один и тот же набор классов красил и кнопку, и чип, и алерт.
// ============================================================
import type { CSSProperties } from 'react';

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'waiting' | 'neutral';

interface ToneVars extends CSSProperties {
  '--tone-bg': string;
  '--tone-border': string;
  '--tone-fg': string;
  '--tone-bg-strong': string;
  /** Цвет заливки/иконки — насыщенная база тона (для точек, полосок, иконок). */
  '--tone-base': string;
  /** Сплошная заливка кнопки этого тона + её ховер. */
  '--tone-solid': string;
  '--tone-solid-hover': string;
  /** Текст на сплошной заливке. Обычно белый; у светлых тонов — тёмный. */
  '--tone-on-solid'?: string;
}

// Только var(...): хардкод цвета в компоненте запрещён (DESIGN.md §1) — иначе
// перекраска через globals.css оставит ховеры кнопок старыми.
const TONES: Record<Tone, ToneVars> = {
  accent: Object.freeze({
    '--tone-bg': 'rgba(88, 140, 211, 0.12)',
    '--tone-border': 'rgba(88, 140, 211, 0.3)',
    '--tone-fg': 'var(--primary-dim)',
    '--tone-bg-strong': 'rgba(88, 140, 211, 0.2)',
    '--tone-base': 'var(--primary)',
    '--tone-solid': 'var(--primary)',
    '--tone-solid-hover': 'var(--primary-dim)',
  }),
  success: Object.freeze({
    '--tone-bg': 'rgba(116, 162, 119, 0.14)',
    '--tone-border': 'rgba(116, 162, 119, 0.32)',
    '--tone-fg': 'var(--success)',
    '--tone-bg-strong': 'rgba(116, 162, 119, 0.22)',
    '--tone-base': 'var(--success-base)',
    '--tone-solid': 'var(--success-base)',
    '--tone-solid-hover': 'var(--success-hover)',
  }),
  warning: Object.freeze({
    '--tone-bg': 'rgba(214, 150, 108, 0.16)',
    '--tone-border': 'rgba(214, 150, 108, 0.35)',
    '--tone-fg': 'var(--warning)',
    '--tone-bg-strong': 'rgba(214, 150, 108, 0.24)',
    '--tone-base': 'var(--warning-base)',
    '--tone-solid': 'var(--warning-base)',
    '--tone-solid-hover': 'var(--warning-hover)',
  }),
  danger: Object.freeze({
    '--tone-bg': 'rgba(222, 109, 104, 0.14)',
    '--tone-border': 'rgba(222, 109, 104, 0.32)',
    '--tone-fg': 'var(--danger)',
    '--tone-bg-strong': 'rgba(222, 109, 104, 0.22)',
    '--tone-base': 'var(--danger-base)',
    '--tone-solid': 'var(--danger-base)',
    '--tone-solid-hover': 'var(--danger-hover)',
  }),
  // Ожидание — «ждёт человека или срока». Матовая пара ЛЕГЧЕ общей формулы
  // (8.4%/18% против 12–16/30–35) — утверждено пользователем на глаз, не
  // «чинить» к формуле: чистый #ffd400 ярче остальных баз. Текст = тёмный
  // вариант своей базы (тёмное золото). Собственный --tone-on-solid нужен
  // потому, что сплошная заливка этого тона светлая: белый текст кнопки на
  // ней был бы нечитаем.
  waiting: Object.freeze({
    '--tone-bg': 'var(--waiting-container)',
    '--tone-border': 'var(--waiting-border)',
    '--tone-fg': 'var(--waiting)',
    '--tone-bg-strong': 'var(--waiting-hover)',
    '--tone-base': 'var(--waiting-base)',
    '--tone-solid': 'var(--waiting-base)',
    '--tone-solid-hover': 'var(--waiting-hover)',
    '--tone-on-solid': 'var(--waiting)',
  }),
  neutral: Object.freeze({
    '--tone-bg': 'var(--surface-container)',
    '--tone-border': 'var(--border)',
    '--tone-fg': 'var(--on-surface-variant)',
    '--tone-bg-strong': 'var(--active)',
    '--tone-base': 'var(--muted)',
    '--tone-solid': 'var(--on-surface-variant)',
    '--tone-solid-hover': 'var(--neutral-hover)',
  }),
};

/** Переменные тона — расстелить в style компонента. Объект заморожен: мутация
 *  результата перекрасила бы тон во всём приложении разом. */
export function toneVars(tone: Tone = 'neutral'): CSSProperties {
  return TONES[tone];
}

/** Насыщенный цвет тона — когда нужен чистый цвет, а не матовая пара. */
export const TONE_BASE: Record<Tone, string> = {
  accent: 'var(--primary)',
  success: 'var(--success-base)',
  warning: 'var(--warning-base)',
  danger: 'var(--danger-base)',
  waiting: 'var(--waiting-base)',
  neutral: 'var(--muted)',
};

/** Класс-хелпер: склеивает классы, отбрасывая пустые. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
