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
// Сплошная заливка кнопки (--tone-solid) = ТЁМНАЯ пара тона, не база:
// белому тексту нужно 4.5:1 (AA, утверждено 2026-08-01), базы давали 2.5–3.4.
// ИСКЛЮЧЕНИЕ — синяя (accent): остаётся фирменной светлой базой #588cd3 с белым
// (решение пользователя 2026-08-01: тёмная пара «чересчур строгая», бренд важнее
// формальной нормы; осознанное отступление от AA, 3.4:1).
const TONES: Record<Tone, ToneVars> = {
  accent: Object.freeze({
    '--tone-bg': 'var(--primary-container)',
    '--tone-border': 'var(--primary-border)',
    '--tone-fg': 'var(--primary-dim)',
    '--tone-bg-strong': 'color-mix(in srgb, var(--primary) 20%, transparent)',
    '--tone-base': 'var(--primary)',
    '--tone-solid': 'var(--primary)',
    '--tone-solid-hover': 'var(--primary-dim)',
  }),
  success: Object.freeze({
    '--tone-bg': 'var(--success-container)',
    '--tone-border': 'var(--success-border)',
    '--tone-fg': 'var(--success)',
    '--tone-bg-strong': 'color-mix(in srgb, var(--success-base) 22%, transparent)',
    '--tone-base': 'var(--success-base)',
    '--tone-solid': 'var(--success)',
    '--tone-solid-hover': 'var(--success-hover)',
  }),
  warning: Object.freeze({
    '--tone-bg': 'var(--warning-container)',
    '--tone-border': 'var(--warning-border)',
    '--tone-fg': 'var(--warning)',
    '--tone-bg-strong': 'color-mix(in srgb, var(--warning-base) 24%, transparent)',
    '--tone-base': 'var(--warning-base)',
    '--tone-solid': 'var(--warning)',
    '--tone-solid-hover': 'var(--warning-hover)',
  }),
  danger: Object.freeze({
    '--tone-bg': 'var(--danger-container)',
    '--tone-border': 'var(--danger-border)',
    '--tone-fg': 'var(--danger)',
    '--tone-bg-strong': 'color-mix(in srgb, var(--danger-base) 22%, transparent)',
    '--tone-base': 'var(--danger-base)',
    '--tone-solid': 'var(--danger)',
    '--tone-solid-hover': 'var(--danger-hover)',
  }),
  // Ожидание — «ждёт человека или срока». Матовая пара ЛЕГЧЕ общей формулы
  // (8.4%/18% против 12–16/30–35) — утверждено пользователем на глаз, не
  // «чинить» к формуле: чистый #ffd400 ярче остальных баз. Сплошная заливка,
  // как у всех тонов, — тёмная пара (тёмное золото, белый текст 5.5:1);
  // ховер поднимается к жёлтой базе на четверть. --waiting-hover трогать
  // нельзя — это матовая подложка (bg-strong), а не ховер кнопки.
  waiting: Object.freeze({
    '--tone-bg': 'var(--waiting-container)',
    '--tone-border': 'var(--waiting-border)',
    '--tone-fg': 'var(--waiting)',
    '--tone-bg-strong': 'var(--waiting-hover)',
    '--tone-base': 'var(--waiting-base)',
    '--tone-solid': 'var(--waiting)',
    // 88%, не 75: жёлтая база настолько светлее, что на четверти подъёма
    // белый текст падал до 3.7
    '--tone-solid-hover': 'color-mix(in srgb, var(--waiting) 88%, var(--waiting-base))',
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
