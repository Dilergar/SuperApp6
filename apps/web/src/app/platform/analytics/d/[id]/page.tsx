'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AnalyticsSection } from '@/components/platform/analytics/AnalyticsSection';
import { DashboardView } from '@/components/platform/analytics/DashboardView';

// Любой дашборд: id или системный ключ (`/platform/analytics/d/funnels`).
export default function PlatformAnalyticsDashboardPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={null}>
      <AnalyticsSection>
        <DashboardView key={id} idOrKey={id} />
      </AnalyticsSection>
    </Suspense>
  );
}
