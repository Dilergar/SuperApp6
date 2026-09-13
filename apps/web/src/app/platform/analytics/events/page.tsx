'use client';

import { Suspense } from 'react';
import { AnalyticsSection } from '@/components/platform/analytics/AnalyticsSection';
import { EventCatalog } from '@/components/platform/analytics/EventCatalog';

// «Что мы измеряем» — периоду здесь не место: панель управления не показывается.
export default function PlatformAnalyticsEventsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsSection controls={false}>
        <EventCatalog />
      </AnalyticsSection>
    </Suspense>
  );
}
