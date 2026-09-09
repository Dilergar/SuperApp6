'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { DurationUnits } from './process-lib';

/**
 * Сокращения единиц длительности для `humanizeDuration`: чистая функция слов не
 * знает (тот же приём, что у `formatBytes` и `useByteUnits`).
 */
export function useDurationUnits(): DurationUnits {
  const t = useTranslations('processes');
  const tc = useTranslations('common');
  return useMemo(
    () => ({
      sec: t('duration.sec'),
      min: t('duration.min'),
      hour: t('duration.hour'),
      day: t('duration.day'),
      dash: tc('labels.dash'),
    }),
    [t, tc],
  );
}
