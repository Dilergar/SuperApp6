'use client';

import { Suspense } from 'react';
import { AnalyticsSection } from '@/components/platform/analytics/AnalyticsSection';
import { ReportBuilder } from '@/components/platform/analytics/ReportBuilder';

// Статический путь `new` — ДО `[id]` (Next разрешает сам, но правило проекта держим и тут).
export default function PlatformAnalyticsNewReportPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsSection>
        <ReportBuilder />
      </AnalyticsSection>
    </Suspense>
  );
}
