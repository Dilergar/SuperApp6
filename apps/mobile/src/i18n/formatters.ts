import { useMemo } from 'react';
import { createFormatters, type Formatters } from '@superapp/i18n/format';
import { useLocaleStore } from './locale';

/**
 * Форматтеры платформы для экранов: ИМЕНА месяцев и дней от языка, ПРАВИЛА
 * (порядок частей даты, разделители, первый день недели, валюта) от региона.
 *
 * Часовой пояс не передаём: время показывается в поясе УСТРОЙСТВА — ровно то,
 * что человеку и нужно на телефоне.
 */
export function useFormatters(): Formatters {
  const locale = useLocaleStore((s) => s.locale);
  return useMemo(() => createFormatters(locale), [locale]);
}
