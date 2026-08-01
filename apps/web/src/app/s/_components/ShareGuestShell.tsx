'use client';

// ============================================================
// Хром гостевой страницы /s/<токен>.
//
// Каркас приложения здесь не нужен и вреден: у гостя нет аккаунта, а сайдбар с
// «Задачами» и «Финансами» вёл бы его в никуда. Форма взята у экранов входа
// (app/auth-ui.tsx) — та же карточка на тёплом полотне.
// ============================================================

import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

export function ShareGuestShell({
  title,
  subtitle,
  children,
  wide,
}: {
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Папка шире карточки входа: в ней таблица */
  wide?: boolean;
}) {
  return (
    <div style={{ minHeight: '100vh', padding: 'var(--spacing-6)' }}>
      <div style={{ width: '100%', maxWidth: wide ? 880 : 520, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: 'var(--spacing-5)',
          }}
        >
          <span className="app-logo-mark">S</span>
          <span className="app-logo-name">SuperApp6</span>
        </div>

        <div className="card">
          {title && (
            <h1 className="title-md" style={{ margin: 0, wordBreak: 'break-word' }}>
              {title}
            </h1>
          )}
          {subtitle && (
            <p className="body-sm" style={{ margin: '0.375rem 0 0', color: 'var(--on-surface-variant)' }}>
              {subtitle}
            </p>
          )}
          {(title || subtitle) && <div style={{ height: 'var(--spacing-5)' }} />}
          {children}
        </div>

        <p
          className="label-sm"
          style={{ textAlign: 'center', marginTop: 'var(--spacing-5)', color: 'var(--on-surface-variant)' }}
        >
          Этим поделились с вами через SuperApp6
        </p>
      </div>
    </div>
  );
}

/** Тупик: ссылки нет, её отозвали, истёк срок, исчерпан лимит, объект удалён */
export function ShareGuestError({ title, description }: { title: string; description: string }) {
  return (
    <ShareGuestShell>
      <div style={{ textAlign: 'center', padding: 'var(--spacing-6) 0' }}>
        <Icon name="blocked" size={36} style={{ color: 'var(--on-surface-variant)' }} />
        <h1 className="title-md" style={{ margin: 'var(--spacing-4) 0 0.375rem' }}>
          {title}
        </h1>
        <p className="body-sm" style={{ margin: 0, color: 'var(--on-surface-variant)' }}>
          {description}
        </p>
      </div>
    </ShareGuestShell>
  );
}
