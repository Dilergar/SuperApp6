'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { LifecycleDuration } from '@superapp/shared';

/**
 * Срок словами на языке зрителя: «Вечно», «90 дней», «5 лет». Годы — когда срок кратен году
 * (реестр считает год как 365,25 суток: 3 года = 1096, 75 лет = 27394), иначе сутки.
 */
export function useDurationLabel(): (d: LifecycleDuration) => string {
  const t = useTranslations('lifecycle');
  return useCallback(
    (d: LifecycleDuration) => {
      if (d === 'forever') return t('duration.forever');
      const years = Math.round(d / 365.25);
      if (years >= 1 && Math.abs(years * 365.25 - d) <= 1.5) return t('duration.years', { years });
      return t('duration.days', { days: d });
    },
    [t],
  );
}

/** Сравнение сроков: `'forever'` — бесконечность. */
export function durationValue(d: LifecycleDuration): number {
  return d === 'forever' ? Number.POSITIVE_INFINITY : d;
}
