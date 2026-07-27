'use client';

// ============================================================
// Chip / Badge / StatusDot — матовые метки статусов и фильтров.
// ============================================================
import { memo, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, TONE_BASE, type Tone } from './tones';

export interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
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
  const inner = (
    <>
      {emoji && <span aria-hidden style={{ fontSize: size === 'sm' ? '0.75rem' : '0.85rem', lineHeight: 1 }}>{emoji}</span>}
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
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
