'use client';

// ============================================================
// GuardedValue — защищённое поле (core/visibility, провод `Guarded<T>`). Чистый рендер, без
// API: значение → `render`, маска → символы маски (+ слот действия: кнопку «Показать» рисует
// `components/visibility/RevealButton`), скрыто → ничего (или тихий чип «Скрыто»).
//
// Правило DESIGN.md: защищённое поле = <GuardedValue>, а не `value ?? '—'`: маркер «скрыто»
// и «пусто» (`null`) — разные вещи, и только сервер решает, что из них показать.
// ============================================================
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isHidden, isMasked, type Guarded } from '@superapp/shared';
import { Chip } from './Chip';

export interface GuardedValueProps<T> {
  value: Guarded<T>;
  /** Как нарисовать видимое значение (по умолчанию — текстом). `null` = пусто. */
  render?: (value: T) => ReactNode;
  /** Скрытое поле показать тихим чипом «Скрыто» (по умолчанию — не рисовать вовсе) */
  placeholder?: boolean;
  /** Что рисовать на месте пустого (`null`) значения */
  empty?: ReactNode;
  /** Слот рядом с маской (кнопка «Показать» — только в карточке ОДНОЙ записи) */
  maskAction?: ReactNode;
  className?: string;
}

export function GuardedValue<T>({ value, render, placeholder, empty = null, maskAction, className }: GuardedValueProps<T>) {
  const t = useTranslations('common');
  if (isHidden(value)) {
    return placeholder ? (
      <Chip size="sm" icon="lock" tone="neutral" className={className}>
        {t('guarded.hidden')}
      </Chip>
    ) : null;
  }
  if (isMasked(value)) {
    return (
      <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
        <span className="tabular-nums" aria-label={t('guarded.masked')}>
          {value.display ?? '•••'}
        </span>
        {value.reveal === 'one' ? maskAction : null}
      </span>
    );
  }
  if (value === null || value === undefined) return <>{empty}</>;
  return <span className={className}>{render ? render(value as T) : String(value)}</span>;
}
