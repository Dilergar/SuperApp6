'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AnalyticsSection } from '@/components/platform/analytics/AnalyticsSection';
import { ReportBuilder } from '@/components/platform/analytics/ReportBuilder';

export default function PlatformAnalyticsReportPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={null}>
      <AnalyticsSection>
        <ReportBuilder key={id} reportId={id} />
      </AnalyticsSection>
    </Suspense>
  );
}
