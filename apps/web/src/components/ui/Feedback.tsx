'use client';

// ============================================================
// Spinner / Skeleton / AvatarStack — мелкие индикаторы и группа аватаров.
// ============================================================
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './tones';

export function Spinner({ size = 18, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={cx('ui-spinner', className)}
      style={{ width: size, height: size, ...style }}
      role="status"
      aria-label="Загрузка"
    />
  );
}

/** Крупная заглушка загрузки раздела. */
export function LoadingBlock({ text = 'Загружаем…' }: { text?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: 'var(--spacing-12)' }}>
      <Spinner size={24} />
      <span className="label-sm">{text}</span>
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cx('ui-skeleton', className)}
      style={{ display: 'block', width, height, borderRadius: radius ?? 'var(--radius-sm)', ...style }}
      aria-hidden
    />
  );
}

/**
 * Стек аватаров с нахлёстом и остатком «+N».
 * Сами аватары рисует вызывающий (`PersonAvatar`) — правило продукта: человек
 * показывается карточкой, поэтому кит только раскладывает, а не рисует лицо.
 */
export function AvatarStack({
  children,
  overflow,
  size = 32,
  overlap = 10,
}: {
  children: ReactNode[];
  /** Сколько ещё людей скрыто. */
  overflow?: number;
  size?: number;
  overlap?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {children.map((child, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            marginLeft: i === 0 ? 0 : -overlap,
            border: `2px solid var(--block)`,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--block)',
          }}
        >
          {child}
        </span>
      ))}
      {overflow && overflow > 0 ? (
        <span
          style={{
            width: size, height: size, minWidth: size,
            marginLeft: children.length ? -overlap : 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 'var(--radius-pill)',
            border: '2px solid var(--block)',
            background: 'var(--active)',
            fontSize: '0.6875rem', fontWeight: 700, color: 'var(--on-surface-variant)',
          }}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
