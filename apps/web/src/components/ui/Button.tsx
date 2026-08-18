'use client';

// ============================================================
// Button / IconButton — единственный источник кнопок в приложении.
// Своя кнопка на странице = нарушение правила кита (DESIGN.md §7).
// ============================================================
import Link from 'next/link';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, type Tone } from './tones';

export type ButtonVariant = 'primary' | 'matte' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Матовый тон — работает у variant='matte' (и красит ghost-ховер). */
  tone?: Tone;
  /** Иконка слева. */
  icon?: IconName;
  /** Иконка справа (каретка, стрелка). */
  iconRight?: IconName;
  /** Занять всю ширину контейнера. */
  block?: boolean;
  /** Показать спиннер и заблокировать нажатия. */
  loading?: boolean;
  /** Отрендерить ссылкой (next/link) вместо кнопки. */
  href?: string;
  children?: ReactNode;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 15, md: 17, lg: 19 };

export function Button({
  variant = 'matte',
  size = 'md',
  tone = 'accent',
  icon,
  iconRight,
  block,
  loading,
  href,
  children,
  className,
  style,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', className);
  const css = { ...toneVars(tone), ...style };
  const inner = (
    <>
      {loading ? (
        <span className="ui-spinner" style={{ width: ICON_SIZE[size], height: ICON_SIZE[size] }} aria-hidden />
      ) : (
        icon && <Icon name={icon} size={ICON_SIZE[size]} />
      )}
      {children}
      {iconRight && <Icon name={iconRight} size={ICON_SIZE[size]} />}
    </>
  );

  // Ссылка-кнопка: <a> не умеет disabled, поэтому «выключенную» ссылку
  // отдаём настоящей кнопкой — иначе по ней можно уйти кликом или Enter'ом.
  if (href && !disabled && !loading) {
    return (
      <Link href={href} className={cls} style={css} {...(rest as Record<string, unknown>)}>
        {inner}
      </Link>
    );
  }

  return (
    <button type={type} className={cls} style={css} disabled={disabled || loading} {...rest}>
      {inner}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  icon: IconName;
  /** Обязательна: кнопка без текста должна называться для скринридера. */
  label: string;
  size?: number;
  iconSize?: number;
  variant?: 'plain' | 'outline' | 'danger';
  /** Круглая (топбар) или скруглённый квадрат (панели). */
  round?: boolean;
  href?: string;
}

// forwardRef: якорь нужен всплывающим слоям (Menu, Tooltip) для позиционирования
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 38, iconSize, variant = 'plain', round = true, href, className, style, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = cx('ui-iconbtn', variant !== 'plain' && `ui-iconbtn--${variant}`, className);
  const css = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: round ? 'var(--radius-pill)' : 'var(--radius-sm)',
    ...style,
  };
  const glyph = <Icon name={icon} size={iconSize ?? Math.round(size * 0.52)} />;

  if (href && !disabled) {
    return (
      // ref пробрасывается и ссылке: якорь нужен Menu/Tooltip — без него слой
      // позиционировался бы в левом верхнем углу экрана.
      <Link ref={ref as React.Ref<HTMLAnchorElement>} href={href} className={cls} style={css} aria-label={label} title={label} {...(rest as Record<string, unknown>)}>
        {glyph}
      </Link>
    );
  }
  return (
    <button ref={ref} type={type} className={cls} style={css} aria-label={label} title={label} disabled={disabled} {...rest}>
      {glyph}
    </button>
  );
});

export interface CloseChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** Подпись для скринридера. */
  label?: string;
  size?: number;
}

/**
 * Единый красный чип-крестик закрытия (решение продукта 2026-08-19): ВСЕ
 * «крестики сверху» оверлеев — модалка кита, пикеры, лайтбокс, панели —
 * рисуются ТОЛЬКО им. Свой крестик на странице = нарушение кита (как у Button).
 */
export const CloseChip = forwardRef<HTMLButtonElement, CloseChipProps>(function CloseChip(
  { label = 'Закрыть', size = 30, className, ...rest },
  ref,
) {
  return (
    <IconButton
      ref={ref}
      icon="close"
      label={label}
      size={size}
      className={cx('ui-close-chip', className)}
      {...rest}
    />
  );
});
