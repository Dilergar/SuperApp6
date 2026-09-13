'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { AnalyticsConsentDto } from '@superapp/shared';
import { Toggle } from '@/components/ui';
import { apiErrorMessage, apiGet, apiPatch } from '@/lib/api';
import { analytics } from '@/lib/analytics';
import { analyticsConsentKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';

/**
 * «Аналитика использования» в настройках профиля. Тумблер показывает СОГЛАСИЕ
 * (включён = собираем), а сервер хранит отказ: применяет его при приёме — клиентские
 * события перестают записываться, факты работы сервиса остаются. Объяснение в три
 * строки: что собираем, чего не собираем, что остаётся при отключении.
 */
export function AnalyticsConsentSection() {
  const t = useTranslations('profile');
  const qc = useQueryClient();
  const consent = useQuery({
    queryKey: analyticsConsentKey,
    queryFn: () => apiGet<AnalyticsConsentDto>('/analytics/consent'),
  });
  const save = useMutation({
    mutationFn: (optOut: boolean) => apiPatch<AnalyticsConsentDto>('/analytics/consent', { optOut }),
    onSuccess: (data) => {
      qc.setQueryData(analyticsConsentKey, data);
      analytics.setOptOut(data.optOut);
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });

  const optOut = save.isPending ? !!save.variables : !!consent.data?.optOut;

  return (
    <div className="card-elevated" style={{ padding: 'var(--spacing-6)', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)', marginTop: 'var(--spacing-4)' }}>
      <h3 className="title-md" style={{ margin: 0 }}>{t('settings.analytics.title')}</h3>
      <Toggle
        checked={!optOut}
        disabled={consent.isLoading || save.isPending}
        onChange={(on) => save.mutate(!on)}
        label={t('settings.analytics.label')}
      />
      <ul style={{ margin: 0, paddingInlineStart: 'var(--spacing-4)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)', fontSize: '0.75rem', color: 'var(--on-surface-variant)' }}>
        <li>{t('settings.analytics.collect')}</li>
        <li>{t('settings.analytics.notCollect')}</li>
        <li>{t('settings.analytics.remains')}</li>
      </ul>
    </div>
  );
}
