'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { AnalyticsSection, useAnalyticsParams } from '@/components/platform/analytics/AnalyticsSection';
import { ReportLibrary } from '@/components/platform/analytics/ReportLibrary';

function NewReportButton() {
  const t = useTranslations('analytics');
  const params = useAnalyticsParams();
  return <Button variant="primary" icon="add" href={params.href('/platform/analytics/reports/new')}>{t('library.new')}</Button>;
}

export default function PlatformAnalyticsReportsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsSection actions={<NewReportButton />}>
        <ReportLibrary />
      </AnalyticsSection>
    </Suspense>
  );
}
