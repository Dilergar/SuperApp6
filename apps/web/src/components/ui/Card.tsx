'use client';

// ============================================================
// Card / CardHeader / PageHeader / StatTile / EmptyState / Divider
// — структурные блоки бенто-сетки.
// ============================================================
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from './Icon';
import { cx, toneVars, type Tone } from './tones';

export interface CardProps {
  children: ReactNode;
  /** Мелкая карточка: радиус 20 и меньший внутренний отступ. */
  small?: boolean;
  /** Сколько колонок 12-колоночной сетки занимает. */
  span?: number;
  /** Приподнимать на ховере (карточки-ссылки). */
  hoverable?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
}

export function Card({ children, small, span, hoverable, className, style, onClick }: CardProps) {
  // Ховер — CSS-классом (.ui-card-hover в ui.css), а не записью в element.style:
  // JS-ховер на каждой карточке бенто-сетки — ровно тот антипаттерн, ради
  // устранения которого кит и заведён.
  const lift = hoverable || !!onClick;
  return (
    <div
      className={cx(small ? 'card-sm' : 'card', lift && 'ui-card-hover', className)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        gridColumn: span ? `span ${span}` : undefined,
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Шапка карточки: заголовок слева, действия справа. */
export function CardHeader({
  title,
  subtitle,
  actions,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: 'var(--spacing-4)', ...style }}>
      <div style={{ minWidth: 0 }}>
        {typeof title === 'string' ? <div className="title-md">{title}</div> : title}
        {subtitle && <div className="label-sm" style={{ marginTop: '0.25rem' }}>{subtitle}</div>}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 'none' }}>{actions}</div>}
    </div>
  );
}

/** Шапка экрана: хлебная крошка-капс + H2 + чип + действия справа. */
export function PageHeader({
  breadcrumb,
  title,
  chip,
  actions,
  description,
}: {
  breadcrumb?: string;
  title: ReactNode;
  chip?: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-6)', flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        {breadcrumb && <div className="label-caps" style={{ marginBottom: '0.375rem' }}>{breadcrumb}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h1 className="title-lg" style={{ margin: 0 }}>{title}</h1>
          {chip}
        </div>
        {description && <p className="body-sm" style={{ margin: '0.5rem 0 0', maxWidth: 560 }}>{description}</p>}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>{actions}</div>}
    </div>
  );
}

/** Плитка показателя: подпись + иконка в матовом круге + крупная цифра + тренд. */
export function StatTile({
  label,
  value,
  icon,
  emoji,
  tone = 'accent',
  trend,
  href,
  onClick,
  span,
}: {
  label: string;
  value: ReactNode;
  icon?: IconName;
  emoji?: string | null;
  tone?: Tone;
  trend?: { text: string; direction: 'up' | 'down' };
  href?: string;
  onClick?: () => void;
  span?: number;
}) {
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: 'var(--spacing-3)' }}>
        <span className="label-caps">{label}</span>
        {(icon || emoji) && (
          <span
            style={{
              width: 34, height: 34, minWidth: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-pill)', ...toneVars(tone),
              background: 'var(--tone-bg)', border: '1px solid var(--tone-border)', color: 'var(--tone-fg)',
            }}
          >
            {emoji ? <span aria-hidden style={{ fontSize: '1rem', lineHeight: 1 }}>{emoji}</span> : icon ? <Icon name={icon} size={18} /> : null}
          </span>
        )}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.875rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
        {value}
      </div>
      {trend && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.5rem',
            fontSize: '0.75rem', fontWeight: 700,
            color: trend.direction === 'up' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          <Icon name={trend.direction === 'up' ? 'trendUp' : 'trendDown'} size={15} />
          {trend.text}
        </div>
      )}
    </>
  );
  return (
    <Card small span={span} hoverable={!!(href || onClick)} onClick={onClick}>
      {/* next/link, НЕ сырой <a>: сырой якорь на внутренний адрес = полная
          перезагрузка приложения (потеря кэша, сокета и всего состояния). */}
      {href ? <Link href={href} style={{ color: 'inherit', display: 'block' }}>{body}</Link> : body}
    </Card>
  );
}

/** Заглушка пустого раздела. */
export function EmptyState({
  icon = 'empty',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: 'var(--spacing-12) var(--spacing-6)', textAlign: 'center' }}>
      <span
        style={{
          width: 56, height: 56, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--radius-pill)', background: 'var(--surface-container)', color: 'var(--muted)',
        }}
      >
        <Icon name={icon} size={26} />
      </span>
      <div className="title-sm">{title}</div>
      {description && <p className="body-sm" style={{ margin: 0, maxWidth: 380 }}>{description}</p>}
      {action && <div style={{ marginTop: '0.5rem' }}>{action}</div>}
    </div>
  );
}

/** Разделитель внутри блока (единственная допустимая линия внутри карточки). */
export function Divider({ style }: { style?: CSSProperties }) {
  return <div style={{ height: 1, background: 'var(--divider)', margin: 'var(--spacing-4) 0', ...style }} />;
}

/** Бенто-сетка на 12 колонок; на телефоне складывается в одну (класс .ui-bento). */
export function BentoGrid({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="ui-bento" style={style}>
      {children}
    </div>
  );
}
