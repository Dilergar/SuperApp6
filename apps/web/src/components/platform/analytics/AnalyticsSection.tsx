'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, PageHeader, Tabs } from '@/components/ui';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { analyticsQualityKey, fetchAnalyticsQuality } from '@/lib/platform/analytics';
import { AnalyticsControls } from './AnalyticsControls';
import { useAnalyticsParams } from './useAnalyticsParams';

type SectionTab = 'dashboards' | 'reports' | 'events';

/**
 * Каркас раздела: шапка, вкладки Дашборды · Отчёты · События (адреса, не состояние),
 * панель управления (кроме каталога событий — ему период не нужен).
 */
export function AnalyticsSection({ children, actions, controls = true }: { children: ReactNode; actions?: ReactNode; controls?: boolean }) {
  const t = useTranslations('analytics');
  const tp = useTranslations('platform');
  const pathname = usePathname();
  const router = useRouter();
  const params = useAnalyticsParams();
  const { can, isReady } = usePlatformAuth();
  const allowed = isReady && can('analytics.read');
  const quality = useQuery({ queryKey: analyticsQualityKey, queryFn: fetchAnalyticsQuality, staleTime: 60_000, enabled: allowed });
  const tab: SectionTab = pathname.startsWith('/platform/analytics/reports') ? 'reports' : pathname.startsWith('/platform/analytics/events') ? 'events' : 'dashboards';
  const target: Record<SectionTab, string> = {
    dashboards: '/platform/analytics',
    reports: '/platform/analytics/reports',
    events: '/platform/analytics/events',
  };
  return (
    <>
      <PageHeader breadcrumb={tp('shell.title')} title={tp('nav.analytics')} description={t('section.description')} actions={actions} />
      <div style={{ marginBottom: 'var(--spacing-3)' }}>
        <Tabs<SectionTab>
          value={tab}
          onChange={(k) => router.push(params.href(target[k]))}
          items={[
            { key: 'dashboards', label: t('tabs.dashboards'), icon: 'dashboard' },
            { key: 'reports', label: t('tabs.reports'), icon: 'chart' },
            { key: 'events', label: t('tabs.events'), icon: 'list' },
          ]}
          aria-label={tp('nav.analytics')}
        />
      </div>
      {!isReady ? null : !allowed ? (
        <Alert tone="warning">{t('section.noAccess')}</Alert>
      ) : (
        <>
          {controls && <AnalyticsControls quality={quality.data ?? null} />}
          {children}
        </>
      )}
    </>
  );
}

export { useAnalyticsParams };
