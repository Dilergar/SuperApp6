'use client';

// ============================================================
// Общая обёртка экранов входа: вход, регистрация, сброс пароля.
// Раньше каждая страница верстала себя сама — отсюда разные отступы,
// разные размеры заголовка и три вида плашки ошибки.
// ============================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui';

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  /** Шаги мастера (регистрация): текущий и всего. */
  step,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  step?: { current: number; total: number; labels: string[] };
}) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-6)' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <Link
          href="/"
          className="label-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', marginBottom: 'var(--spacing-5)', color: 'var(--on-surface-variant)' }}
        >
          <Icon name="arrowLeft" size={15} /> На главную
        </Link>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: 'var(--spacing-6)' }}>
            <span className="app-logo-mark">S</span>
            <span className="app-logo-name">SuperApp6</span>
          </div>

          {step && <StepDots current={step.current} total={step.total} labels={step.labels} />}

          <h1 className="title-lg" style={{ margin: '0 0 0.375rem' }}>{title}</h1>
          {subtitle && <p className="body-sm" style={{ margin: '0 0 var(--spacing-6)' }}>{subtitle}</p>}
          {!subtitle && <div style={{ height: 'var(--spacing-5)' }} />}

          {children}
        </div>

        {footer && (
          <p className="body-sm" style={{ textAlign: 'center', marginTop: 'var(--spacing-5)' }}>
            {footer}
          </p>
        )}
      </div>
    </div>
  );
}

function StepDots({ current, total, labels }: { current: number; total: number; labels: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: 'var(--spacing-5)' }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: i < total - 1 ? 1 : undefined }}>
          <span
            style={{
              width: 22, height: 22, minWidth: 22, borderRadius: '50%',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.6875rem', fontWeight: 700,
              background: i <= current ? 'var(--primary)' : 'transparent',
              color: i <= current ? '#fff' : 'var(--on-surface-variant)',
              border: i <= current ? 'none' : '1px solid var(--border)',
            }}
            title={labels[i]}
          >
            {i < current ? <Icon name="check" size={12} /> : i + 1}
          </span>
          {i < total - 1 && (
            <span style={{ flex: 1, height: 1, background: i < current ? 'var(--primary)' : 'var(--divider)' }} />
          )}
        </div>
      ))}
    </div>
  );
}
