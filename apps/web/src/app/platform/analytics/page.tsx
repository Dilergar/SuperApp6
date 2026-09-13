'use client';

import { Suspense } from 'react';
import { AnalyticsSection } from '@/components/platform/analytics/AnalyticsSection';
import { DashboardView } from '@/components/platform/analytics/DashboardView';

// «Аналитика» открывается ОТВЕТОМ — системным дашбордом «Обзор», а не списком дашбордов.
export default function PlatformAnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsSection>
        <DashboardView idOrKey="overview" />
      </AnalyticsSection>
    </Suspense>
  );
}
