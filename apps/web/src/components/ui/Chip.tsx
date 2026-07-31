'use client';

// ============================================================
// Chip / Badge / StatusDot — матовые метки статусов и фильтров.
// ============================================================
import { memo, type CSSProperties, type ReactNode } from 'react';
import { Glyph } from './Glyph';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, TONE_BASE, type Tone } from './tones';

export interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
  /**
   * Значок из БД — ЛЮБОЕ значение значка ('ph:car', 'fl:1f697', 'nt:…', голое
   * эмодзи). Имя пропа историческое: рисует его `Glyph`, а не печатает текстом.
   */
  emoji?: string | null;
  size?: 'sm' | 'md';
  /** Кликабельный чип-фильтр. */
  onClick?: () => void;
  /** Выбранное состояние чипа-фильтра (иначе рисуется нейтральным). */
  selected?: boolean;
  /** Кнопка «убрать» справа. */
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

// memo: чипы рендерятся сотнями в списках; текстовые children сравниваются по
// значению, так что ре-рендер родителя чип с теми же пропсами не перестраивает.
export const Chip = memo(function Chip({
  children,
  tone = 'neutral',
  icon,
  emoji,
  size = 'md',
  onClick,
  selected,
  onRemove,
  removeLabel = 'Убрать',
  title,
  className,
  style,
}: ChipProps) {
  // У чипа-фильтра невыбранное состояние всегда нейтральное: иначе десяток
  // разноцветных чипов в строке фильтров читается как набор статусов.
  const effective: Tone = onClick && selected === false ? 'neutral' : tone;
  const css = { ...toneVars(effective), ...style };
  const iconSize = size === 'sm' ? 13 : 15;
  const label = (
    <>
      {emoji && <Glyph value={emoji} size={iconSize} />}
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
    </>
  );
  const inner = (
    <>
      {label}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label={removeLabel}
          className="ui-chip-x"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(); } }}
        >
          <Icon name="close" size={12} />
        </span>
      )}
    </>
  );
  const cls = cx('ui-chip', size === 'sm' && 'ui-chip--sm', onClick && 'ui-chip--button', className);

  // Чип, который и открывают, и убирают. Обёртка здесь — span с двумя кнопками
  // внутри: кнопка (или что угодно с tabindex) ВНУТРИ кнопки — невалидная
  // разметка, и в дереве доступности читается как «управление внутри
  // управления». Разметка расходится только у этого сочетания — остальные
  // чипы (просто метка, только клик, только крестик) рисуются как раньше.
  if (onClick && onRemove) {
    return (
      <span className={cx(cls, 'ui-chip--split')} style={css}>
        <button type="button" className="ui-chip-main" onClick={onClick} title={title} aria-pressed={selected}>
          {label}
        </button>
        <button type="button" className="ui-chip-x" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      </span>
    );
  }

  if (onClick) {
    return (
      <button type="button" className={cls} style={css} onClick={onClick} title={title} aria-pressed={selected}>
        {inner}
      </button>
    );
  }
  return <span className={cls} style={css} title={title}>{inner}</span>;
});

/** Счётчик-пилюля (непрочитанное, количество). */
export function Badge({ children, tone = 'accent', style }: { children: ReactNode; tone?: Tone; style?: CSSProperties }) {
  return (
    <span
      className="ui-chip ui-chip--sm"
      style={{ ...toneVars(tone), minWidth: '1.35rem', justifyContent: 'center', padding: '0.0625rem 0.4375rem', ...style }}
    >
      {children}
    </span>
  );
}

/** Цветная точка статуса (в строках списков, где чип слишком тяжёлый). */
export const StatusDot = memo(function StatusDot({ tone = 'neutral', size = 8, title }: { tone?: Tone; size?: number; title?: string }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? 'img' : undefined}
      style={{ width: size, height: size, minWidth: size, borderRadius: '50%', background: TONE_BASE[tone], display: 'inline-block' }}
    />
  );
});
