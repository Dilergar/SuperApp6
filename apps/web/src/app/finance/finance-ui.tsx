'use client';

// ============================================================
// Общие мини-виджеты Финансов — одна точка правды для порогов лимита,
// значка строки и денежной суммы. Используются всеми разделами сервиса.
// ============================================================

import type { CSSProperties, ReactNode } from 'react';
import { EmojiIcon, Icon, ICONS, TickBar, type IconName, type Tone } from '@/components/ui';
import { formatMoney } from './finance-lib';

/** Пороги лимита — синхронны с бэкенд-уведомлениями 80%/100%. */
export function budgetProgress(spent: number, amount: number): {
  pct: number;
  over: boolean;
  warn: boolean;
  tone: Tone;
  color: string;
} {
  const pct = amount > 0 ? Math.round((spent / amount) * 100) : 0;
  const over = spent > amount;
  const warn = !over && spent >= amount * 0.8;
  const tone: Tone = over ? 'danger' : warn ? 'warning' : 'success';
  return { pct, over, warn, tone, color: `var(--${tone})` };
}

/** Штриховой план-факт лимита (DESIGN.md §5 — сплошных полосок в системе нет). */
export function BudgetBar({ spent, amount, small }: { spent: number; amount: number; small?: boolean }) {
  const { pct, tone } = budgetProgress(spent, amount);
  return <TickBar value={pct} tone={tone} height={small ? 8 : 10} aria-label="Израсходовано от лимита" />;
}

/**
 * Значок строки Финансов.
 *
 * ЛОВУШКА: одно и то же поле `icon` несёт либо ИМЯ иконки кита (наш
 * интерфейсный фолбэк: 'card', 'receipt', 'refresh'), либо ЭМОДЗИ, выбранное
 * человеком в БД (иконка счёта/категории/долга). Печатать значение как текст
 * нельзя — «card» напечаталось бы словом. Поэтому решает эта функция, а места
 * показа вызывают только её.
 */
export function FinGlyph({
  glyph,
  size = 30,
  tone = 'neutral',
  fallback = 'card',
  style,
}: {
  glyph: string | null | undefined;
  size?: number;
  tone?: Tone;
  fallback?: IconName;
  style?: CSSProperties;
}) {
  const emojiTone = tone === 'accent' || tone === 'success' || tone === 'warning' || tone === 'danger' ? tone : 'neutral';
  // Имя из реестра кита → интерфейсная иконка в матовом круге того же размера,
  // что и подложка эмодзи: строки списков не «прыгают» между двумя видами.
  if (glyph && glyph in ICONS) {
    return <EmojiIcon emoji={null} size={size} tone={emojiTone} fallback={glyph as IconName} style={style} />;
  }
  return <EmojiIcon emoji={glyph ?? null} size={size} tone={emojiTone} fallback={fallback} style={style} />;
}

/** Денежная сумма моноширинного веса: знак + сумма, цвет по смыслу. */
export function Money({
  minor,
  code,
  sign = '',
  tone,
  size = '0.9375rem',
  bold = 700,
}: {
  minor: number;
  code: string;
  sign?: '+' | '−' | '';
  /** Явный тон; по умолчанию — обычный текст. */
  tone?: 'success' | 'danger' | 'muted';
  size?: string;
  bold?: number;
}) {
  const color = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : tone === 'muted' ? 'var(--muted)' : 'var(--on-surface)';
  return (
    <span style={{ fontFamily: 'var(--font-display)', fontWeight: bold, fontSize: size, color, whiteSpace: 'nowrap' }}>
      {sign}{formatMoney(minor, code)}
    </span>
  );
}

/** Крупная цифра показателя (30px/800) — значение StatTile и итогов месяца. */
export function BigMoney({ children, tone }: { children: ReactNode; tone?: 'success' | 'danger' }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        color: tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--on-surface)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * Мультивалютное значение показателя: суммы по валютам в столбик.
 * Пусто → прочерк (ноль тоже ответ, но «нет записей» честнее показать тире).
 */
export function MoneyStack({
  sums,
  sign = '',
  tone,
}: {
  sums: Array<{ currencyCode: string; amount: number }>;
  sign?: '+' | '−' | '';
  tone?: 'success' | 'danger';
}) {
  if (sums.length === 0) return <BigMoney>—</BigMoney>;
  return (
    <span style={{ display: 'grid' }}>
      {sums.map((s) => (
        <BigMoney key={s.currencyCode} tone={tone}>
          {sign}{formatMoney(s.amount, s.currencyCode)}
        </BigMoney>
      ))}
    </span>
  );
}

/** Строка списка Финансов: значок + содержимое + сумма справа. */
export function FinRow({
  glyph,
  glyphTone,
  glyphFallback,
  title,
  subtitle,
  right,
  actions,
  href,
  onClick,
}: {
  glyph?: string | null;
  glyphTone?: Tone;
  glyphFallback?: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  /** Действия строки — показываются на ховере и при фокусе с клавиатуры. */
  actions?: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      {glyph !== undefined && <FinGlyph glyph={glyph} tone={glyphTone} fallback={glyphFallback} size={30} />}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="title-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          {title}
        </span>
        {subtitle && <span className="label-sm" style={{ display: 'block', marginTop: '0.125rem' }}>{subtitle}</span>}
      </span>
      {/* Действия строки видны всегда: показ «только на ховере» (как было)
          недостижим с клавиатуры и на телефоне. */}
      {actions && <span style={{ display: 'flex', gap: '0.25rem', flex: 'none' }}>{actions}</span>}
      {right && <span style={{ flex: 'none', textAlign: 'right' }}>{right}</span>}
    </>
  );

  const css: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-3)',
    padding: '0.5rem 0.75rem',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--divider)',
    color: 'var(--on-surface)',
    textAlign: 'left',
    width: '100%',
  };

  if (href) return <a href={href} style={css}>{inner}</a>;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={{ ...css, background: 'none', cursor: 'pointer' }}>
        {inner}
      </button>
    );
  }
  return <div style={css}>{inner}</div>;
}

/** Вертикальный список строк с шагом плотности. */
export function FinList({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: 'grid', gap: '0.375rem', ...style }}>{children}</div>;
}
